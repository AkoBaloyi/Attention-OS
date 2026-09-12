/**
 * Static checks on the dashboard page.
 *
 * The HTTP tests assert that markup and handlers are present, which does not
 * prove the inline script parses or that it reaches for elements that exist.
 * Both of those fail as a blank page rather than as an error, which is the worst
 * possible way to discover them: silently, on camera.
 *
 * There is no browser here, so this parses the module body with the JavaScript
 * parser and cross-checks every element id against the markup.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(
  new URL('../src/server/dashboard.html', import.meta.url),
  'utf8',
);

const source = (() => {
  const match = /<script type="module">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(match, 'dashboard.html must contain a module script');
  return match[1]!;
})();

describe('the dashboard page holds together', () => {
  test('the inline script parses', () => {
    // Wrapped in an async arrow because the module body uses top-level await.
    assert.doesNotThrow(() => {
      new Function(`return (async () => { ${source} });`);
    });
  });

  test('every element id the script reaches for exists in the markup', () => {
    const referenced = new Set([...source.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]!));
    const declared = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]!));

    const missing = [...referenced].filter((id) => !declared.has(id)).sort();
    assert.deepEqual(missing, [], `script reads ids that do not exist: ${missing.join(', ')}`);
    assert.ok(referenced.size > 20, 'sanity check that the scan actually found things');
  });

  test('the tags that structure the dialog balance', () => {
    for (const [open, close] of [
      ['<dialog', '</dialog>'],
      ['<form', '</form>'],
      ['<fieldset', '</fieldset>'],
      ['<details', '</details>'],
    ] as const) {
      const opens = html.split(open).length - 1;
      const closes = html.split(close).length - 1;
      assert.equal(opens, closes, `${open} against ${close}`);
    }
  });

  test('no state variable is read after being removed', () => {
    // Two rewrites of the filter state have already left dangling references
    // behind. These names belonged to earlier versions and must stay gone.
    for (const stale of ['searchTerm', 'active.get(', 'active.values(']) {
      assert.ok(!source.includes(stale), `stale reference to ${stale}`);
    }
  });

  test('buttons inside the filter form declare a type', () => {
    // A button in a form defaults to submit, which would close the dialog
    // through method="dialog" instead of running its handler.
    const form = /<form[^>]*id="filter-form"[\s\S]*?<\/form>/.exec(html)?.[0] ?? '';
    assert.ok(form.length > 0, 'filter form should be present');

    const buttons = [...form.matchAll(/<button[^>]*>/g)].map((m) => m[0]);
    assert.ok(buttons.length >= 3);
    for (const button of buttons) {
      assert.match(button, /type="button"/, button);
    }
  });

  test('interactive controls carry accessible names', () => {
    assert.match(html, /aria-labelledby="filter-dialog-title"/);
    assert.match(html, /id="close-filters"[^>]*aria-label="Close"/);
    assert.match(html, /<label class="visually-hidden" for="search">|<label for="search">/);
  });
});
