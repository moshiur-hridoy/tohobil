import { describe, expect, it } from 'vitest';
import { canAttach, pastedFile, pastedName } from './attachFile';

const file = (name: string, type: string) => new File(['x'], name, { type });

describe('pasting and dropping into a file picker', () => {
  it('takes only the types the picker and the server both accept', () => {
    expect(canAttach('image/png', 'image/*,application/pdf')).toBe(true);
    expect(canAttach('application/pdf', 'image/*,application/pdf')).toBe(true);
    expect(canAttach('application/pdf', 'image/jpeg,image/png')).toBe(false);
    expect(canAttach('image/gif', 'image/*')).toBe(false);
    expect(canAttach('text/plain', 'image/*,application/pdf')).toBe(false);
  });

  it('names a clipboard picture a screenshot and keeps a real file name', () => {
    expect(pastedName('image.png', 'image/png')).toBe('screenshot.png');
    expect(pastedName('', 'image/jpeg')).toBe('screenshot.jpg');
    expect(pastedName('রসিদ.pdf', 'application/pdf')).toBe('রসিদ.pdf');
  });

  it('picks the first acceptable file, or none', () => {
    const got = pastedFile([file('a.txt', 'text/plain'), file('image.png', 'image/png')], 'image/*');
    expect(got?.name).toBe('screenshot.png');
    expect(got?.type).toBe('image/png');
    expect(pastedFile([file('a.txt', 'text/plain')], 'image/*')).toBeNull();
  });
});
