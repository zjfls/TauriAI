import { describe, it, expect } from 'vitest';
import { parseFileReferenceToken } from './fileReference';

describe('parseFileReferenceToken', () => {
  it('parses colon style', () => {
    expect(parseFileReferenceToken('src/app.ts:42')).toEqual({ filePath: 'src/app.ts', line: 42 });
    expect(parseFileReferenceToken('src/app.ts:42:7')).toEqual({ filePath: 'src/app.ts', line: 42, column: 7 });
  });

  it('parses hash style', () => {
    expect(parseFileReferenceToken('b/server/index.js#L10')).toEqual({ filePath: 'server/index.js', line: 10 });
    expect(parseFileReferenceToken('a/foo.rs#L9C2')).toEqual({ filePath: 'foo.rs', line: 9, column: 2 });
  });

  it('tolerates colon ranges (drops end)', () => {
    expect(parseFileReferenceToken('events.rs:96-125')).toEqual({ filePath: 'events.rs', line: 96 });
    expect(parseFileReferenceToken('events.rs:96:3-125:9')).toEqual({ filePath: 'events.rs', line: 96, column: 3 });
  });

  it('tolerates hash ranges (drops end)', () => {
    expect(parseFileReferenceToken('events.rs#L96-L125')).toEqual({ filePath: 'events.rs', line: 96 });
    expect(parseFileReferenceToken('events.rs#L96C3-L125C9')).toEqual({ filePath: 'events.rs', line: 96, column: 3 });
  });

  it('accepts Windows paths and avoids URL lookalikes', () => {
    expect(parseFileReferenceToken('C:\\repo\\main.rs:12-20')).toEqual({ filePath: 'C:\\repo\\main.rs', line: 12 });
    expect(parseFileReferenceToken('https://example.com/a.ts:1')).toBeNull();
  });
});

