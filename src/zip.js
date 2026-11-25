'use strict';
// Arhivă ZIP simplă, fără compresie (PDF-urile și documentele Office sunt deja comprimate), produsă în flux:
// fișierele nu se încarcă întregi în memorie. Suma de control (CRC-32) se calculează înainte de fiecare
// fișier, ca antetul să fie complet; așa arhiva se deschide în orice program, inclusiv în Windows Explorer.
const fs = require('node:fs');
const zlib = require('node:zlib');

const MAX_ENTRIES = 65000; // limita formatului ZIP clasic (fără ZIP64)
const MAX_TOTAL = 3.5 * 1024 ** 3; // sub 4 GB, aceeași limită

function dosDateTime(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

async function crcOf(file) {
  let crc = 0;
  for await (const chunk of fs.createReadStream(file)) crc = zlib.crc32(chunk, crc);
  return crc >>> 0;
}

// entries: [{ name: 'dosar/fisier.pdf', file: '/cale/pe/disc', size }]
async function* zipStream(entries) {
  const { time, date } = dosDateTime(new Date());
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const crc = await crcOf(e.file);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4); // versiunea necesară
    head.writeUInt16LE(0x0800, 6); // numele în UTF-8
    head.writeUInt16LE(0, 8); // fără compresie
    head.writeUInt16LE(time, 10);
    head.writeUInt16LE(date, 12);
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(e.size, 18);
    head.writeUInt32LE(e.size, 22);
    head.writeUInt16LE(name.length, 26);
    head.writeUInt16LE(0, 28);
    yield head;
    yield name;
    let written = 0;
    for await (const chunk of fs.createReadStream(e.file)) {
      written += chunk.length;
      yield chunk;
    }
    if (written !== e.size) throw new Error(`Fișierul ${e.name} s-a modificat în timpul arhivării.`);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(0, 10);
    c.writeUInt16LE(time, 12);
    c.writeUInt16LE(date, 14);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(e.size, 20);
    c.writeUInt32LE(e.size, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += 30 + name.length + e.size;
  }
  const dir = Buffer.concat(central);
  yield dir;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  yield end;
}

// Nume sigur pentru un dosar sau un fișier din arhivă (Windows nu acceptă unele caractere).
const safeName = (s, max = 120) =>
  String(s)
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_')
    .replace(/[. ]+$/, '')
    .trim()
    .slice(0, max) || '_';

module.exports = { zipStream, safeName, MAX_ENTRIES, MAX_TOTAL };
