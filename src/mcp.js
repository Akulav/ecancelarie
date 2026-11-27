'use strict';
// Serverul MCP (Model Context Protocol): asistenții AI (Claude, alți clienți MCP) lucrează cu documentele
// prin POST /api/mcp, în transportul „Streamable HTTP” fără stare (fiecare cerere JSON-RPC primește un răspuns JSON).
//
// Autentificarea se face cu un jeton personal (Authorization: Bearer …), creat de utilizator în aplicație.
// Asistentul acționează în numele acelui utilizator, cu exact aceleași drepturi: documentele trec prin
// accessClause, modificările prin aceleași funcții ca formularul din pagină, iar jurnalul de audit
// consemnează fiecare acțiune cu numele jetonului. Jetoanele „doar citire” nu pot modifica nimic.
// Ce nu poate face un asistent: semna (cere tokenul fizic), șterge documente, administra conturi sau setări.
const path = require('node:path');
const fs = require('node:fs');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_TEXT = 200000; // cel mult atâtea caractere dintr-un fișier, într-un singur răspuns
const MAX_BLOB = 10 * 1024 * 1024; // PDF-urile și imaginile se trimit întregi doar până la această mărime
const TEXT_EXT = ['.txt', '.csv', '.md', '.json', '.xml', '.html', '.htm', '.rtf', '.log', '.tsv'];
const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

// ---------- extragerea textului din fișierele Office (arhive ZIP cu XML) ----------
// Cititor ZIP minimal: directorul central, apoi fiecare intrare (stocată sau comprimată „deflate”).
function zipEntries(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('arhivă ZIP nevalidă');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let n = 0; n < count && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    entries.set(name, { method, size, local });
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  const read = (name) => {
    const e = entries.get(name);
    if (!e || buf.readUInt32LE(e.local) !== 0x04034b50) return null;
    const start = e.local + 30 + buf.readUInt16LE(e.local + 26) + buf.readUInt16LE(e.local + 28);
    const data = buf.subarray(start, start + e.size);
    if (e.method === 0) return data.toString('utf8');
    // limita de ieșire protejează serverul de arhivele „bombă”
    if (e.method === 8) return zlib.inflateRawSync(data, { maxOutputLength: 64 * 1024 * 1024 }).toString('utf8');
    return null;
  };
  return { names: [...entries.keys()], read };
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decodeXml = (s) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) =>
    e[0] === '#' ? codePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e.toLowerCase()]
  );
// caracterele imposibile (peste U+10FFFF) devin „�” în loc să arunce o eroare
const codePoint = (n) => (Number.isInteger(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '\ufffd');
const stripXml = (s) => decodeXml(s.replace(/<[^>]+>/g, ''));
const natural = (a, b) => a.localeCompare(b, undefined, { numeric: true });

function docxText(zip) {
  const xml = zip.read('word/document.xml');
  if (xml === null) throw new Error('documentul Word nu conține word/document.xml');
  return stripXml(xml.replace(/<w:tab\/>/g, '\t').replace(/<w:br[^>]*\/>/g, '\n').replace(/<\/w:p>/g, '\n'));
}
function pptxText(zip) {
  const slides = zip.names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort(natural);
  return slides.map((n, i) => `--- Diapozitivul ${i + 1} ---\n` + stripXml(zip.read(n).replace(/<\/a:p>/g, '\n'))).join('\n');
}
function xlsxText(zip) {
  const shared = [];
  const sst = zip.read('xl/sharedStrings.xml');
  if (sst) for (const m of sst.matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(stripXml(m[1].replace(/<rPh[\s\S]*?<\/rPh>/g, '')));
  const sheets = zip.names.filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort(natural);
  const out = [];
  sheets.forEach((n, i) => {
    out.push(`--- Foaia ${i + 1} ---`);
    for (const row of zip.read(n).matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = [];
      for (const c of row[1].matchAll(/<c([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1];
        const body = c[2] || '';
        const ref = (attrs.match(/r="([A-Z]+)\d+"/) || [])[1];
        const col = ref ? [...ref].reduce((a, ch) => a * 26 + ch.charCodeAt(0) - 64, 0) - 1 : cells.length;
        const v = (body.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        let val = '';
        if (/t="s"/.test(attrs)) val = shared[Number(v)] ?? '';
        else if (/t="inlineStr"/.test(attrs)) val = stripXml(body);
        else if (v !== undefined) val = decodeXml(v);
        while (cells.length < col) cells.push('');
        cells[col] = val.replace(/[\t\n]+/g, ' ');
      }
      if (cells.some(Boolean)) out.push(cells.join('\t'));
    }
  });
  return out.join('\n');
}
function odfText(zip) {
  const xml = zip.read('content.xml');
  if (xml === null) throw new Error('fișierul OpenDocument nu conține content.xml');
  return stripXml(xml.replace(/<text:tab\/>/g, '\t').replace(/<text:line-break\/>/g, '\n').replace(/<\/text:(p|h)>/g, '\n'));
}
const OFFICE_TEXT = { '.docx': docxText, '.pptx': pptxText, '.xlsx': xlsxText, '.odt': odfText, '.ods': odfText, '.odp': odfText };

// ---------- înregistrarea în aplicație ----------
module.exports = function registerMcp(app, h) {
  const { db, fail, str, isId, sha, audit, UPLOAD_DIR, MAX_FILE } = h;
  const VERSION = require('../package.json').version;

  // Autentificarea cu jetonul personal. Jetoanele greșite se numără pe IP, ca la autentificare.
  async function requireToken(req, reply) {
    const ipKey = 'mcp|' + req.ip;
    if (h.isBlocked(ipKey)) throw fail(429, 'Prea multe încercări. Reîncercați peste câteva minute.');
    if (!h.mcpEnabled()) throw fail(403, 'Accesul asistenților AI este dezactivat de administrator.');
    const auth = String(req.headers.authorization || '');
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    const row = token
      ? db
          .prepare(
            `SELECT t.id AS token_id, t.name AS token_name, t.can_write, u.id, u.username, u.full_name, u.position, u.email, u.unit_id, u.role, u.must_change, u.created_at
             FROM api_tokens t JOIN users u ON u.id = t.user_id
             WHERE t.token_hash = ? AND t.expires_at > datetime('now') AND u.active = 1`
          )
          .get(sha(token))
      : null;
    if (!row) {
      h.recordFail(ipKey, 30);
      reply.header('WWW-Authenticate', 'Bearer realm="e-Management ANSC"');
      throw fail(401, 'Jeton de acces invalid, expirat sau revocat.');
    }
    if (row.must_change) throw fail(403, 'Titularul jetonului trebuie să își schimbe mai întâi parola în aplicație.');
    const { token_id, token_name, can_write, ...user } = row;
    // momentul ultimei folosiri, scris cel mult o dată la 5 minute
    db.prepare("UPDATE api_tokens SET last_used_at = datetime('now') WHERE id = ? AND (last_used_at IS NULL OR last_used_at < datetime('now', '-5 minutes'))").run(token_id);
    req.user = user;
    req.viaToken = token_name;
    req.tokenWrite = !!can_write;
  }

  // ---------- utilitare pentru instrumente ----------
  const norm = (s) => String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  const ids = (v) => (Array.isArray(v) ? v.map(Number).filter(isId) : []);
  const needWrite = (req) => {
    if (!req.tokenWrite) throw fail(403, 'Jetonul folosit permite doar citirea. Creați în aplicație un jeton cu drept de modificare.');
  };
  const needEditor = (req) => {
    needWrite(req);
    if (req.user.role === 'user') throw fail(403, 'Contul dvs. nu are dreptul de a adăuga sau modifica documente.');
  };
  const nameMaps = () => ({
    tags: new Map(db.prepare('SELECT t.id, t.name, c.name AS category FROM tags t JOIN categories c ON c.id = t.category_id').all().map((t) => [t.id, `${t.category}: ${t.name}`])),
    units: new Map(db.prepare('SELECT id, name FROM units').all().map((u) => [u.id, u.name])),
    users: new Map(db.prepare('SELECT id, full_name FROM users').all().map((u) => [u.id, u.full_name])),
  });
  const signStatus = (d) => {
    if (!d.signers.length) return 'fără semnatari';
    const done = d.signers.filter((s) => s.signed_at).length;
    if (done === d.signers.length) return 'semnat de toți';
    const turn = d.signers.find((s) => s.id === d.signTurn);
    return `${done}/${d.signers.length} semnături; la rând: ${turn ? turn.name : '—'}`;
  };
  function getDoc(req, id) {
    const d = isId(id) ? h.listDocuments(req.user, id)[0] : null;
    if (!d) throw fail(404, `Documentul #${id} nu a fost găsit sau nu aveți acces la el.`);
    return d;
  }
  function accessibleFile(req, fileId) {
    const acc = h.accessClause(req.user);
    const f = isId(fileId)
      ? db
          .prepare(`SELECT f.id, f.name, f.stored, f.size, f.document_id FROM document_files f JOIN documents d ON d.id = f.document_id WHERE f.id = ? AND ${acc.sql}`)
          .get(fileId, ...acc.params)
      : null;
    if (!f || !fs.existsSync(path.join(UPLOAD_DIR, f.stored))) throw fail(404, `Fișierul #${fileId} nu a fost găsit sau nu aveți acces la el.`);
    return f;
  }
  // Fișierele trimise de asistent (base64 sau text) se scriu pe disc la fel ca o încărcare din pagină.
  function saveFiles(list) {
    if (list === undefined || list === null) return [];
    if (!Array.isArray(list)) throw fail(400, '„files” trebuie să fie o listă.');
    if (list.length > 10) throw fail(400, 'Cel mult 10 fișiere la o încărcare.');
    const saved = [];
    try {
      for (const f of list) {
        const name = str(path.basename(String(f?.name ?? '')), 200);
        if (!name) throw fail(400, 'Fiecare fișier are nevoie de un nume (cu extensie, ex. „raport.docx”).');
        let data;
        if (typeof f.content_base64 === 'string') data = Buffer.from(f.content_base64, 'base64');
        else if (typeof f.text === 'string') data = Buffer.from(f.text, 'utf8');
        else throw fail(400, `Fișierul „${name}” nu are conținut („content_base64” sau „text”).`);
        if (!data.length) throw fail(400, `Fișierul „${name}” este gol.`);
        if (data.length > MAX_FILE) throw fail(413, 'Fișierul depășește limita de 50 MB.');
        const stored = crypto.randomBytes(16).toString('hex');
        fs.writeFileSync(path.join(UPLOAD_DIR, stored), data);
        saved.push({ stored, name, size: data.length });
      }
      return saved;
    } catch (e) {
      h.removeStored(saved.map((x) => x.stored));
      throw e;
    }
  }
  const json = (v) => ({ content: [{ type: 'text', text: JSON.stringify(v, null, 1) }] });

  // ---------- instrumentele ----------
  const idsSchema = (description) => ({ type: 'array', items: { type: 'integer' }, description });
  const docFields = {
    title: { type: 'string', description: 'Denumirea documentului (obligatorie la creare).' },
    number: { type: 'string', description: 'Numărul de înregistrare.' },
    doc_date: { type: 'string', description: 'Data documentului, AAAA-LL-ZZ; șir gol = fără dată.' },
    description: { type: 'string', description: 'Descriere / rezumat.' },
    visibility: { type: 'string', enum: ['all', 'restricted'], description: '„all” = vizibil tuturor; „restricted” = doar subdiviziunile și persoanele indicate (plus autorul și semnatarii).' },
    tag_ids: idsSchema('Etichetele (vezi list_categories).'),
    unit_ids: idsSchema('Subdiviziunile cu acces, doar la „restricted” (vezi list_units).'),
    user_ids: idsSchema('Persoanele cu acces, doar la „restricted” (vezi list_people).'),
    signer_ids: idsSchema('Semnatarii, în ordinea semnării (vezi list_people). Fiecare primește documentul când îi vine rândul.'),
    review_until: { type: 'string', description: 'Avizare: până la această dată (AAAA-LL-ZZ, inclusiv) cei care văd documentul pot propune modificări în editor. Șir gol = fără avizare.' },
    sign_until: { type: 'string', description: 'Termenul de semnare (AAAA-LL-ZZ); cu o zi înainte și apoi zilnic, semnatarul aflat la rând primește o reamintire. Șir gol = fără termen.' },
  };
  const filesSchema = {
    type: 'array',
    description: 'Fișiere de atașat (cel mult 10, câte 50 MB). Fiecare: { name, content_base64 } sau, pentru text simplu, { name, text }.',
    items: {
      type: 'object',
      properties: { name: { type: 'string' }, content_base64: { type: 'string' }, text: { type: 'string' } },
      required: ['name'],
    },
  };
  const READ = { readOnlyHint: true, openWorldHint: false };
  const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

  const tools = [
    {
      name: 'whoami',
      title: 'Cine sunt',
      description: 'Utilizatorul în numele căruia lucrează asistentul: nume, rol, subdiviziune și dacă jetonul permite modificări. Data de azi a serverului.',
      inputSchema: { type: 'object', properties: {} },
      annotations: READ,
      run: (req) => {
        const unit = req.user.unit_id ? db.prepare('SELECT name FROM units WHERE id = ?').get(req.user.unit_id) : null;
        return json({
          id: req.user.id,
          username: req.user.username,
          full_name: req.user.full_name,
          position: req.user.position,
          role: { admin: 'administrator', editor: 'editor (poate adăuga documente)', user: 'angajat (doar citire și semnare)' }[req.user.role],
          unit: unit ? unit.name : null,
          token: req.viaToken,
          token_can_write: req.tokenWrite,
          today: h.localToday(),
        });
      },
    },
    {
      name: 'search_documents',
      title: 'Caută documente',
      description:
        'Caută în documentele pe care utilizatorul le poate vedea (după text în denumire, număr, descriere, autor și numele fișierelor), cu filtre opționale. Întoarce o listă scurtă; detaliile complete se obțin cu get_document.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Text căutat (fără diferență între majuscule și diacritice). Toate cuvintele trebuie să apară.' },
          status: {
            type: 'string',
            enum: ['all', 'my_turn', 'waiting_others', 'unseen', 'mine', 'unsigned'],
            description: 'my_turn = e rândul meu să semnez; waiting_others = am semnat sau aștept, dar lanțul nu e complet; unseen = nedeschise încă; mine = create de mine; unsigned = cu semnături lipsă.',
          },
          tag_ids: idsSchema('Doar documentele cu cel puțin una dintre aceste etichete.'),
          category_id: { type: 'integer', description: 'Doar documentele cu o etichetă din această categorie.' },
          from_date: { type: 'string', description: 'Data documentului de la (AAAA-LL-ZZ).' },
          to_date: { type: 'string', description: 'Data documentului până la (AAAA-LL-ZZ).' },
          limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Implicit 30.' },
          offset: { type: 'integer', minimum: 0 },
        },
      },
      annotations: READ,
      run: (req, a) => {
        const m = nameMaps();
        let docs = h.listDocuments(req.user);
        const words = norm(a.query).split(/\s+/).filter(Boolean);
        if (words.length) {
          docs = docs.filter((d) => {
            const hay = norm([d.title, d.number, d.description, d.author, ...d.files.map((f) => f.name)].join(' '));
            return words.every((w) => hay.includes(w));
          });
        }
        const st = a.status || 'all';
        if (st === 'my_turn') docs = docs.filter((d) => d.mySign === 'pending');
        if (st === 'waiting_others') docs = docs.filter((d) => d.mySign && d.mySign !== 'pending' && d.signers.some((s) => !s.signed_at));
        if (st === 'unseen') docs = docs.filter((d) => d.unseen);
        if (st === 'mine') docs = docs.filter((d) => d.created_by === req.user.id);
        if (st === 'unsigned') docs = docs.filter((d) => d.signers.some((s) => !s.signed_at));
        const tagIds = ids(a.tag_ids);
        if (tagIds.length) docs = docs.filter((d) => d.tagIds.some((t) => tagIds.includes(t)));
        if (isId(Number(a.category_id))) {
          const inCat = new Set(db.prepare('SELECT id FROM tags WHERE category_id = ?').all(Number(a.category_id)).map((t) => t.id));
          docs = docs.filter((d) => d.tagIds.some((t) => inCat.has(t)));
        }
        if (a.from_date) docs = docs.filter((d) => d.doc_date && d.doc_date >= String(a.from_date));
        if (a.to_date) docs = docs.filter((d) => d.doc_date && d.doc_date <= String(a.to_date));
        const limit = Math.min(200, Math.max(1, Number(a.limit) || 30));
        const offset = Math.max(0, Number(a.offset) || 0);
        return json({
          total: docs.length,
          offset,
          documents: docs.slice(offset, offset + limit).map((d) => ({
            id: d.id,
            title: d.title,
            number: d.number || undefined,
            doc_date: d.doc_date || undefined,
            author: d.author,
            tags: d.tagIds.map((t) => m.tags.get(t)),
            files: d.files.map((f) => ({ id: f.id, name: f.name })),
            signing: signStatus(d),
            my_sign: d.mySign || undefined,
            unseen: d.unseen || undefined,
          })),
        });
      },
    },
    {
      name: 'get_document',
      title: 'Detaliile unui document',
      description: 'Toate datele unui document: descriere, etichete, vizibilitate, fișiere (cu id pentru read_file), lanțul de semnare și ce poate face utilizatorul cu el.',
      inputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
      annotations: READ,
      run: (req, a) => {
        const d = getDoc(req, Number(a.id));
        const m = nameMaps();
        return json({
          id: d.id,
          title: d.title,
          number: d.number,
          doc_date: d.doc_date,
          description: d.description,
          author: d.author,
          created_at: d.created_at,
          tags: d.tagIds.map((t) => ({ id: t, name: m.tags.get(t) })),
          visibility: d.visibility,
          shared_with_units: d.unitIds.map((u) => ({ id: u, name: m.units.get(u) })),
          shared_with_people: d.userIds.map((u) => ({ id: u, name: m.users.get(u) })),
          review_until: d.review_until || null,
          review_open: d.reviewOpen,
          sign_until: d.sign_until || null,
          favorite: d.fav || undefined,
          // pachet: documentele legate (doar cele pe care utilizatorul le vede), fiecare cu semnatarii lui
          linked_documents: d.bundle_id
            ? h.listDocuments(req.user).filter((x) => x.bundle_id === d.bundle_id && x.id !== d.id).map((x) => ({ id: x.id, title: x.title, signing: signStatus(x) }))
            : undefined,
          files: d.files.map((f) => ({
            id: f.id,
            name: f.name,
            size: f.size,
            signed_version_by: f.signed_by_name || undefined,
            version: f.version > 1 ? f.version : undefined,
            edited_by: f.edited_by_name || undefined,
          })),
          signers: d.signers.map((s, i) => ({
            order: i + 1,
            id: s.id,
            name: s.name,
            signed_at: s.signed_at,
            absent_today: s.absent ? `${s.absent.kind} până la ${s.absent.to_date}${s.absent.substitute_name ? ', înlocuit de ' + s.absent.substitute_name : ''}` : undefined,
            signed_by_substitute: s.signed_by_name || undefined,
            inactive: s.active ? undefined : true,
          })),
          signing: signStatus(d),
          my_sign: d.mySign,
          can_edit: d.canEdit,
        });
      },
    },
    {
      name: 'read_file',
      title: 'Citește un fișier',
      description:
        'Conținutul unui fișier atașat. Din Word (.docx), Excel (.xlsx), PowerPoint (.pptx), OpenDocument și fișierele text se întoarce textul; PDF-urile și imaginile se trimit întregi (până la 10 MB). Textele lungi se citesc pe bucăți cu offset.',
      inputSchema: {
        type: 'object',
        properties: {
          file_id: { type: 'integer' },
          offset: { type: 'integer', minimum: 0, description: 'De la al câtelea caracter (pentru textele lungi).' },
          max_chars: { type: 'integer', minimum: 1000, maximum: MAX_TEXT, description: 'Implicit 50000.' },
        },
        required: ['file_id'],
      },
      annotations: READ,
      run: async (req, a) => {
        const f = accessibleFile(req, Number(a.file_id));
        const ext = path.extname(f.name).toLowerCase();
        const file = path.join(UPLOAD_DIR, f.stored);
        h.markSeen(req.user.id, f.document_id);
        audit(req, 'fișier citit', `#${f.document_id} ${f.name}`);
        if (ext === '.pdf' || IMAGE_TYPES[ext]) {
          if (f.size > MAX_BLOB) throw fail(400, `„${f.name}” are ${(f.size / 1048576).toFixed(1)} MB; prin MCP se trimit doar fișiere de până la 10 MB.`);
          const data = (await fs.promises.readFile(file)).toString('base64');
          if (IMAGE_TYPES[ext]) return { content: [{ type: 'image', data, mimeType: IMAGE_TYPES[ext] }] };
          return {
            content: [
              { type: 'text', text: `PDF „${f.name}” (${f.size} octeți), atașat mai jos.` },
              { type: 'resource', resource: { uri: `ansc://files/${f.id}`, mimeType: 'application/pdf', blob: data } },
            ],
          };
        }
        let text;
        if (OFFICE_TEXT[ext]) {
          try {
            text = OFFICE_TEXT[ext](zipEntries(await fs.promises.readFile(file)));
          } catch (e) {
            throw fail(400, `Textul din „${f.name}” nu a putut fi extras: ${e.message}.`);
          }
        } else if (TEXT_EXT.includes(ext)) {
          text = await fs.promises.readFile(file, 'utf8');
        } else {
          throw fail(400, `Din fișierele „${ext || 'fără extensie'}” nu se poate extrage textul. Formate acceptate: PDF, imagini, ${[...Object.keys(OFFICE_TEXT), ...TEXT_EXT].join(' ')}.`);
        }
        text = text.replace(/\n{3,}/g, '\n\n').trim();
        const offset = Math.max(0, Number(a.offset) || 0);
        const max = Math.min(MAX_TEXT, Math.max(1000, Number(a.max_chars) || 50000));
        const part = text.slice(offset, offset + max);
        const more = offset + part.length < text.length;
        return {
          content: [
            {
              type: 'text',
              text: `Fișierul „${f.name}” (documentul #${f.document_id}), caracterele ${offset}–${offset + part.length} din ${text.length}${more ? ` — continuați cu offset=${offset + part.length}` : ''}:\n\n${part}`,
            },
          ],
        };
      },
    },
    {
      name: 'verify_signatures',
      title: 'Verifică semnăturile unui PDF',
      description: 'Verifică semnăturile electronice dintr-un fișier PDF: cine a semnat, când, dacă semnătura este intactă și dacă certificatul este de încredere.',
      inputSchema: { type: 'object', properties: { file_id: { type: 'integer' } }, required: ['file_id'] },
      annotations: READ,
      run: async (req, a) => {
        const f = accessibleFile(req, Number(a.file_id));
        if (path.extname(f.name).toLowerCase() !== '.pdf') throw fail(400, 'Verificarea semnăturii este disponibilă doar pentru fișiere PDF.');
        return json({ name: f.name, signatures: h.pdfsig.verifyPdf(await fs.promises.readFile(path.join(UPLOAD_DIR, f.stored)), h.DATA_DIR) });
      },
    },
    {
      name: 'list_people',
      title: 'Angajații',
      description: 'Angajații activi (id, nume, funcție, subdiviziune, contacte, absența de azi). Id-urile se folosesc ca semnatari sau persoane cu acces.',
      inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Filtru după nume, funcție sau subdiviziune.' } } },
      annotations: READ,
      run: (req, a) => {
        const m = nameMaps();
        const away = new Map(
          db.prepare('SELECT user_id, kind, to_date FROM absences WHERE from_date <= ? AND to_date >= ?').all(h.localToday(), h.localToday()).map((x) => [x.user_id, x])
        );
        const words = norm(a.query).split(/\s+/).filter(Boolean);
        const people = db
          .prepare('SELECT id, full_name, position, email, phone, unit_id FROM users WHERE active = 1 ORDER BY full_name')
          .all()
          .map((u) => ({
            id: u.id,
            full_name: u.full_name,
            position: u.position || undefined,
            unit: m.units.get(u.unit_id),
            email: u.email || undefined,
            phone: u.phone || undefined,
            absent_today: away.has(u.id) ? `${away.get(u.id).kind} până la ${away.get(u.id).to_date}` : undefined,
          }))
          .filter((u) => words.every((w) => norm([u.full_name, u.position, u.unit].join(' ')).includes(w)));
        return json(people);
      },
    },
    {
      name: 'list_units',
      title: 'Organigrama',
      description: 'Subdiviziunile instituției (id, denumire, tip, subdiviziunea superioară).',
      inputSchema: { type: 'object', properties: {} },
      annotations: READ,
      run: () => json(db.prepare('SELECT id, name, type, parent_id FROM units ORDER BY sort, name').all()),
    },
    {
      name: 'list_categories',
      title: 'Categorii și etichete',
      description: 'Categoriile de documente cu etichetele lor (id-urile etichetelor se folosesc la căutare și la crearea documentelor).',
      inputSchema: { type: 'object', properties: {} },
      annotations: READ,
      run: () => {
        const tags = db.prepare('SELECT id, category_id, name FROM tags ORDER BY name').all();
        return json(
          db
            .prepare('SELECT id, name FROM categories ORDER BY sort, name')
            .all()
            .map((c) => ({ ...c, tags: tags.filter((t) => t.category_id === c.id).map((t) => ({ id: t.id, name: t.name })) }))
        );
      },
    },
    {
      name: 'create_document',
      title: 'Adaugă un document',
      description:
        'Creează un document nou (doar editorii și administratorii, cu un jeton care permite modificări). Dacă are semnatari, primul este anunțat prin e-mail. Verificați id-urile cu list_people / list_categories / list_units înainte.',
      inputSchema: {
        type: 'object',
        properties: {
          ...docFields,
          files: filesSchema,
          link_with: { type: 'integer', description: 'Opțional: id-ul unui document existent (pe care îl puteți modifica). Noul document intră în pachetul lui, ca documente legate cu semnatari diferiți (ex. o anexă semnată de alte persoane).' },
        },
        required: ['title'],
      },
      annotations: WRITE,
      run: async (req, a) => {
        needEditor(req);
        const doc = h.readDoc(
          {
            title: a.title,
            number: a.number,
            doc_date: a.doc_date,
            description: a.description,
            visibility: a.visibility,
            review_until: a.review_until,
            sign_until: a.sign_until,
            tagIds: a.tag_ids,
            unitIds: a.unit_ids,
            userIds: a.user_ids,
            signerIds: a.signer_ids,
            link_with: a.link_with,
          },
          null
        );
        const saved = saveFiles(a.files);
        const r = await h.createDocument(req, doc, saved);
        return json({ ok: true, id: r.id, files_attached: saved.length, mail: r.mail });
      },
    },
    {
      name: 'update_document',
      title: 'Modifică un document',
      description:
        'Modifică un document existent (autorul sau un administrator). Se schimbă doar câmpurile trimise; listele (tag_ids, signer_ids…) înlocuiesc lista veche. Cine a semnat deja rămâne în lanț. Se pot adăuga fișiere (add_files) și elimina fișiere nesemnate (remove_file_ids).',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'integer' }, ...docFields, add_files: filesSchema, remove_file_ids: idsSchema('Fișierele de eliminat (versiunile semnate nu se pot elimina).') },
        required: ['id'],
      },
      annotations: { ...WRITE, destructiveHint: true },
      run: async (req, a) => {
        needEditor(req);
        const d = getDoc(req, Number(a.id));
        if (!d.canEdit) throw fail(403, 'Doar autorul documentului sau un administrator îl poate modifica.');
        const pick = (k, cur) => (a[k] === undefined ? cur : a[k]);
        const doc = h.readDoc(
          {
            title: pick('title', d.title),
            number: pick('number', d.number),
            doc_date: pick('doc_date', d.doc_date),
            description: pick('description', d.description),
            visibility: pick('visibility', d.visibility),
            review_until: pick('review_until', d.review_until),
            sign_until: pick('sign_until', d.sign_until),
            tagIds: pick('tag_ids', d.tagIds),
            unitIds: pick('unit_ids', d.unitIds),
            userIds: pick('user_ids', d.userIds),
            signerIds: pick('signer_ids', d.signers.map((s) => s.id)),
            removeFileIds: a.remove_file_ids,
          },
          d.id
        );
        const saved = saveFiles(a.add_files);
        const r = await h.updateDocument(req, d.id, doc, saved);
        return json({ ok: true, id: d.id, files_attached: saved.length, mail: r.mail });
      },
    },
    {
      name: 'remind_signer',
      title: 'Retrimite notificarea de semnare',
      description: 'Retrimite e-mailul către semnatarul aflat la rând (autorul documentului sau un administrator; cel mult o dată la 5 minute pentru același document).',
      inputSchema: { type: 'object', properties: { id: { type: 'integer', description: 'Id-ul documentului.' } }, required: ['id'] },
      annotations: { ...WRITE, openWorldHint: true },
      run: async (req, a) => {
        needEditor(req);
        const d = getDoc(req, Number(a.id));
        if (!d.canEdit) throw fail(403, 'Doar autorul documentului sau un administrator poate retrimite notificarea.');
        const turn = h.currentSigner(d.id);
        if (!turn) throw fail(400, 'Toți semnatarii au semnat deja.');
        if (Date.now() - (h.reminded.get(d.id) || 0) < 5 * 60000) throw fail(429, 'Notificarea a fost retrimisă recent. Reîncercați peste câteva minute.');
        h.reminded.set(d.id, Date.now());
        return json({ mail: await h.notifySigners(req, d.id, [turn]) });
      },
    },
    {
      name: 'mark_seen',
      title: 'Marchează ca văzut',
      description: 'Marchează un document (sau, fără id, toate documentele) ca văzut, ca să dispară din notificările utilizatorului.',
      inputSchema: { type: 'object', properties: { id: { type: 'integer', description: 'Id-ul documentului; lipsă = toate.' } } },
      annotations: { ...WRITE, idempotentHint: true },
      run: (req, a) => {
        needWrite(req);
        if (a.id === undefined) {
          const acc = h.accessClause(req.user);
          db.prepare(`INSERT OR IGNORE INTO document_seen (user_id, document_id) SELECT ?, d.id FROM documents d WHERE ${acc.sql}`).run(req.user.id, ...acc.params);
        } else h.markSeen(req.user.id, getDoc(req, Number(a.id)).id);
        return json({ ok: true });
      },
    },
  ];
  const byName = new Map(tools.map((t) => [t.name, t]));

  const INSTRUCTIONS =
    'e-Management ANSC: sistemul intern de documente al Agenției Naționale pentru Soluționarea Contestațiilor. ' +
    'Lucrați în numele utilizatorului indicat de whoami și vedeți doar documentele la care are acces. ' +
    'Documentele au fișiere atașate, etichete grupate pe categorii și, opțional, un lanț de semnatari care semnează pe rând ' +
    '(semnarea cere tokenul fizic al persoanei, deci nu se poate face prin acest server). ' +
    'Căutați cu search_documents, citiți cu get_document și read_file; id-urile pentru persoane, subdiviziuni și etichete vin din list_people, list_units, list_categories. ' +
    'Înainte de a crea sau modifica un document, confirmați cu utilizatorul conținutul și semnatarii. Interfața și datele sunt în limba română.';

  async function handle(req, msg) {
    const isRequest = msg && typeof msg === 'object' && msg.jsonrpc === '2.0' && typeof msg.method === 'string';
    if (!isRequest) return { jsonrpc: '2.0', id: msg?.id ?? null, error: { code: -32600, message: 'Cerere JSON-RPC invalidă.' } };
    if (msg.id === undefined || msg.id === null) return null; // notificare (ex. notifications/initialized): fără răspuns
    const ok = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
    const p = msg.params || {};
    switch (msg.method) {
      case 'initialize':
        return ok({
          protocolVersion: PROTOCOL_VERSIONS.includes(p.protocolVersion) ? p.protocolVersion : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'e-management-ansc', title: 'e-Management ANSC', version: VERSION },
          instructions: INSTRUCTIONS,
        });
      case 'ping':
        return ok({});
      case 'tools/list':
        return ok({ tools: tools.map(({ run, ...t }) => t) });
      case 'tools/call': {
        const tool = byName.get(p.name);
        if (!tool) return { jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: `Instrument necunoscut: ${p.name}` } };
        const args = p.arguments && typeof p.arguments === 'object' && !Array.isArray(p.arguments) ? p.arguments : {};
        try {
          return ok(await tool.run(req, args));
        } catch (e) {
          // erorile ajung la asistent ca rezultat (isError), ca să le poată explica sau corecta
          if (!e.expose) req.log.error(e);
          return ok({ content: [{ type: 'text', text: e.expose ? e.message : 'Eroare internă de server.' }], isError: true });
        }
      }
      default:
        return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Metodă necunoscută: ${msg.method}` } };
    }
  }

  // fișierele atașate vin codificate base64 în corpul JSON: limita acoperă 10 fișiere mari
  app.post('/api/mcp', { preHandler: requireToken, bodyLimit: 100 * 1024 * 1024 }, async (req, reply) => {
    const body = req.body;
    if (Array.isArray(body)) {
      const out = (await Promise.all(body.slice(0, 50).map((m) => handle(req, m)))).filter(Boolean);
      return out.length ? out : reply.code(202).send();
    }
    const out = await handle(req, body);
    return out || reply.code(202).send();
  });
  // Serverul nu deschide fluxuri SSE și nu păstrează sesiuni: GET și DELETE nu sunt disponibile.
  const noStream = async (req, reply) => reply.code(405).header('Allow', 'POST').send({ error: 'Folosiți POST.' });
  app.get('/api/mcp', { preHandler: requireToken }, noStream);
  app.delete('/api/mcp', { preHandler: requireToken }, noStream);
};
