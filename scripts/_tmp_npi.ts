import { validNpi } from '../src/pricing/gather.js';
const cases: Array<[unknown, string|null]> = [
  ['NEUROTEST1', null],
  ['1225478969', '1225478969'],
  [' 1225478969 ', '1225478969'],
  ['123456789', null],
  ['12345678901', null],
  ['12345ABC90', null],
  ['', null], [null, null], [undefined, null],
];
let pass = 0;
for (const [input, want] of cases) {
  const got = validNpi(input as any);
  const ok = got === want;
  pass += ok ? 1 : 0;
  console.log(`${ok ? 'PASS' : 'FAIL'}  validNpi(${JSON.stringify(input)}) = ${JSON.stringify(got)}${ok ? '' : `  (wanted ${JSON.stringify(want)})`}`);
}
console.log(`\n${pass}/${cases.length} passed`);
process.exitCode = pass === cases.length ? 0 : 1;
