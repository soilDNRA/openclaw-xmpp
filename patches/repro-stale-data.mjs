// Regression repro for 2026-10-19 Gateway crash:
// socket 'data' -> Client._onData -> this.parser.write(str) with parser===null.
import Connection from '@xmpp/connection';

process.on('uncaughtException', (e) => {
  console.log('UNCAUGHT:', e.constructor.name + ': ' + e.message);
  process.exit(2);
});

const c = new Connection('example.com');
// Post-teardown state: parser detached (as #onParserError/stop() do), socket
// 'data' listener still registered until socket close completes.
c.parser = null;
c._onData(Buffer.from('<stale/>'));
console.log('NO CRASH: stale data ignored');
process.exit(0);
