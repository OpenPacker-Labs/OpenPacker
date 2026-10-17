/**
 * The blocks the oracle's archives are built from (generate.mjs reads them
 * with node-tar and pnpm, cases.mjs composes them).
 */

/**
 * A header and the data of a regular file, padded to whole blocks: ustar, its
 * checksum written `NNNNNN\0 `, unless `edit` changes the header first or
 * `checksum` writes the field another way (a string, or a Buffer's bytes).
 */
export function file(name, text, { prefix = '', edit, checksum } = {}) {
  const body = Buffer.from(text);
  const header = Buffer.alloc(512);
  header.write(name, 0);
  header.write('0000644\0', 100);
  header.write('0000000\0', 108);
  header.write('0000000\0', 116);
  header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124);
  header.write('00000000000\0', 136);
  header.write('        ', 148);
  header.write('0', 156);
  header.write('ustar\0', 257);
  header.write('00', 263);
  header.write(prefix, 345);
  edit?.(header);
  let sum = 0;
  for (const byte of header) sum += byte;
  const field = checksum?.(sum) ?? `${sum.toString(8).padStart(6, '0')}\0 `;
  if (Buffer.isBuffer(field)) field.copy(header, 148);
  else header.write(field, 148);
  return Buffer.concat([
    header,
    body,
    Buffer.alloc((512 - (body.length % 512)) % 512),
  ]);
}

export const Z = Buffer.alloc(512);
export const a = file('package/a.js', 'a');
export const b = file('package/b.js', 'b');
export const c = file('package/c.js', 'c');
/** 512 bytes that are not zero and not a header. */
export const garbage = Buffer.alloc(512, 0x41);
/** What node-tar takes for a null block: a checksum field that is no number, every other byte zero. */
export const N = Buffer.alloc(512);
N.write('        ', 148);

/**
 * A file() with its typeflag (`type`, '' for NUL), its size field or its link
 * name set before the checksum is written. The body is `text`, whatever the
 * size field says.
 */
export function entry(name, text, { type, size, linkname, ...rest } = {}) {
  return file(name, text, {
    ...rest,
    edit: (header) => {
      if (type !== undefined) header.write(type === '' ? '\0' : type, 156);
      if (size !== undefined)
        header.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
      if (linkname) header.write(linkname, 157);
      rest.edit?.(header);
    },
  });
}

/** A base-256 field that node-tar cannot read: its first byte is neither 0x80 nor 0xff. */
export function invalidBase256(length) {
  const field = Buffer.alloc(length);
  field[0] = 0x81;
  return field;
}

/**
 * A pax header (`x`, or `g` for a global one) holding `records`, as the
 * "length key=value" lines pax writes; `options` shape its own header.
 */
export function pax(records, type = 'x', options = {}) {
  const text = Object.entries(records)
    .map(([key, value]) => {
      const line = ` ${key}=${value}\n`;
      let length = line.length;
      length += String(length + String(length).length).length;
      return `${length}${line}`;
    })
    .join('');
  return entry('PaxHeader/x', text, { ...options, type });
}
