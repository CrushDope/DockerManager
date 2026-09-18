import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateCompose } from '../lib/validate-compose.ts';

void test('accepts valid Compose with different space indentation widths', () => {
  for (const width of [2, 4]) {
    const indent = ' '.repeat(width);
    assert.deepEqual(validateCompose(`services:\n${indent}web:\n${indent.repeat(2)}image: nginx:latest\n${indent.repeat(2)}ports:\n${indent.repeat(3)}- "8080:80"`), []);
  }
});
void test('rejects tabs and gives line and column', () => {
  const errors = validateCompose('services:\n\tweb:\n\t\timage: nginx');
  assert.ok(errors.some(e => e.line === 2 && e.column > 0 && e.message.includes('Tab')));
});
void test('rejects broken indentation, duplicate keys, and unclosed arrays', () => {
  for (const content of ['services:\n  web:\n    image: nginx\n   ports: []', 'services:\n  web:\n    image: nginx\n    image: redis', 'services:\n  web:\n    ports: [80']) assert.ok(validateCompose(content).length);
});
void test('rejects invalid Compose structures', () => {
  for (const content of ['', '# services:', '- services', 'services: {}', 'services:\n  web:\nimage: nginx', 'services:\n  web:\n    ports: "80:80"', 'services: []', 'services:\n  web:\n    image: 123', 'services: {}\n---\nservices: {}']) assert.ok(validateCompose(content).length, content);
});
void test('supports anchors and literal scripts and does not expand Compose variables', () => {
  assert.deepEqual(validateCompose('x-image: &image nginx:latest\nservices:\n  web:\n    image: *image\n    command: |\n      echo ${HELLO}\n      echo ready'), []);
});
