// pii-logging.spec.ts: scans src/ so no logger call ever interpolates what the person wrote.
// Railway keeps logs, and cédula, nombre, correo and teléfono all travel as message text.
import * as fs from 'fs';
import * as path from 'path';

const SRC = path.join(__dirname, '..');

// Identifiers that hold user-authored content. `.length` is the sanctioned way to log about
// them, so an expression ending there is not a leak.
const USER_CONTENT = /\b(msg\.text|text|rawText|lowerText|transcript|data\.text|cedula|nombre|email|telefono)\b/;
const LOGGER_CALL = /this\.logger\.(log|warn|error|debug|verbose)\(`([^`]*)`/g;
// An HTTP error body is the provider explaining why a send failed, not anything the person
// typed — and it is the only diagnostic that path has.
const PROVIDER_RESPONSE = /\b(res|response)\.text\(\)/;


function offendingLogs(source: string): string[] {
  const found: string[] = [];
  for (const [, , template] of source.matchAll(LOGGER_CALL)) {
    for (const [, expression] of template.matchAll(/\$\{([^}]*)\}/g)) {
      const expr = expression.trim();
      if (expr.endsWith('.length') || PROVIDER_RESPONSE.test(expr)) continue;
      if (USER_CONTENT.test(expr)) found.push(expr);
    }
  }
  return found;
}

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(full);
    return e.isFile() && e.name.endsWith('.ts') && !e.name.endsWith('.spec.ts') ? [full] : [];
  });
}

describe('no logger call carries user content', () => {
  // Without this the suite would pass on a detector that matches nothing at all.
  it('detects the four calls this rule was written for', () => {
    expect(offendingLogs('this.logger.log(`Message from ${msg.userId}: "${msg.text.slice(0, 80)}"`);'))
      .toEqual(['msg.text.slice(0, 80)']);
    expect(offendingLogs('this.logger.log(`callGroq text="${text.slice(0, 120)}"`);'))
      .toEqual(['text.slice(0, 120)']);
    expect(offendingLogs('this.logger.log(`Voice transcribed: "${(data.text ?? \'\').slice(0, 80)}"`);'))
      .toHaveLength(1);
  });

  it('allows logging how much was said, just not what', () => {
    expect(offendingLogs('this.logger.log(`Message from ${msg.userId} (${msg.text.length} chars)`);'))
      .toEqual([]);
    expect(offendingLogs('this.logger.error(`Twilio send failed: ${res.status} ${await res.text()}`);'))
      .toEqual([]);
  });

  it.each(sourceFiles(SRC).map((f) => [path.relative(SRC, f), f]))('%s', (_name, file) => {
    expect(offendingLogs(fs.readFileSync(file, 'utf8'))).toEqual([]);
  });
});
