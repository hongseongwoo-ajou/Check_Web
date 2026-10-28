// Lichess chess-openings TSV -> openings.json
// { names: ["C50\tItalian Game: Giuoco Piano", ...], book: { "<fen 앞 3필드>": 이름번호 | -1 } }
const fs = require('fs'), path = require('path');
const { Chess } = require('./chess.js');
const dir = process.argv[2], out = process.argv[3];
const key = fen => fen.split(' ').slice(0, 3).join(' ');
const names = [], book = {};
for (const f of ['a', 'b', 'c', 'd', 'e']) {
  const lines = fs.readFileSync(path.join(dir, f + '.tsv'), 'utf8').trim().split('\n').slice(1);
  for (const line of lines) {
    const [eco, name, pgn] = line.replace(/\r$/, '').split('\t');
    const c = new Chess();
    const sans = pgn.replace(/\d+\.\s*/g, '').trim().split(/\s+/);
    for (const san of sans) {
      if (!c.move(san)) throw new Error('bad move ' + san + ' in ' + line);
      const k = key(c.fen());
      if (!(k in book)) book[k] = -1;
    }
    const k = key(c.fen());
    if (book[k] === -1) { book[k] = names.length; names.push(eco + '\t' + name); }
  }
}
fs.writeFileSync(out, JSON.stringify({ names, book }));
console.log('names', names.length, 'positions', Object.keys(book).length, 'bytes', fs.statSync(out).size);
