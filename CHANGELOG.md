# Jurnalul modificărilor

Modificările importante din e-Management ANSC. Versiunile urmează [Semantic Versioning](https://semver.org/).

## [Nelansat]

### Adăugat
- Server MCP pentru asistenții AI (`/api/mcp`): căutarea și citirea documentelor (inclusiv textul din Word, Excel,
  PowerPoint și OpenDocument), verificarea semnăturilor, adăugarea și modificarea documentelor, retrimiterea
  notificărilor. Asistentul lucrează în numele unui angajat, cu drepturile acestuia, printr-un jeton personal
  creat din butonul „Asistent AI”. Accesul este oprit implicit și se pornește din Setări; acțiunile apar în jurnal
  cu mențiunea `[AI: …]`.
- Formularul de document este acum pe pași (date generale, fișiere, etichete și acces, semnare și avizare,
  verificare), cu bară de progres, validarea fiecărui pas și un rezumat înainte de salvare. La modificarea unui
  document se poate sări direct la orice pas și salva oricând.
- Filigran discret cu numele, utilizatorul, data și ora, repetat pe tot ecranul (și peste ferestre și editor):
  o captură de ecran arată cine a văzut informația și când.

### Modificat
- Meniul contului (asistent AI, schimbarea parolei, ieșire) într-un singur buton cu inițialele, în bara de sus.
- Listele goale (documente, notificări) au ilustrație, explicație și o acțiune („Șterge filtrele”, „Document nou”).

### Corectat
- Când puntea de semnare FleetView nu poate fi folosită, mesajul spune acum cauza reală în locul unui
  „nu răspunde” general: agentul refuză adresa site-ului (alt `emanagement_url`), browserul blochează
  accesul la rețeaua locală, sau puntea nu este activată / nu a pornit pe acel calculator.

### Securitate
- Schimbarea sau resetarea parolei și dezactivarea contului revocă jetoanele AI ale persoanei.

## [1.0.2] - 2026-11-21

### Securitate
- Semnăturile PDF: certificatele intermediare incluse în semnătură contează doar dacă sunt certificate de
  autoritate (CA); un certificat obișnuit nu mai poate „emite” un certificat pe numele altcuiva.
- Editorul ONLYOFFICE nu mai poate suprascrie un fișier după ce documentul a primit o semnătură.
- Jurnalul de audit nu mai poate fi modificat (doar curățat, iar curățarea este consemnată).
- Adăugarea, modificarea și ștergerea categoriilor și etichetelor apar acum în jurnalul de audit.

### Corectat
- Un document nou nu își mai pierde fișierele dacă trimiterea e-mailului către semnatar eșuează.

### Modificat
- Fontul Geist este servit de aplicație (latin + latin-ext), fără nicio cerere către alte servere.
- Curățenie: stiluri și cod nefolosite eliminate.

### Eliminat
- Actualizarea automată a bazelor de date create înainte de 1.0.1. O astfel de bază se pornește o dată cu
  versiunea 1.0.1, apoi cu aceasta (aplicația explică asta la pornire).

## [1.0.1] - 2026-11-20

### Modificat
- Documentație: un nou `docs/ARHITECTURA.md` (structura aplicației, regulile de acces, semnarea și copiile de
  rezervă), cu legătură din README.