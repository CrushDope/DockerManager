import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { normalizeStartupPlan } from '../lib/restart-plan.ts';
import {
  generateRestartScript,
  generateStartupScript,
  generateStartupUnit,
} from '../lib/systemd-compose.ts';

void test('normalizes compose startup order and adds newly discovered projects', () => {
  // 未运行的项目默认 enabled: false
  assert.deepEqual(
    normalizeStartupPlan(
      {
        projects: [{ directory: 'database', enabled: true, order: 2, timeoutSeconds: 45 }],
        continueOnError: true,
      },
      ['database', 'apps'],
    ),
    {
      projects: [
        { directory: 'database', enabled: true, order: 2, timeoutSeconds: 45 },
        { directory: 'apps', enabled: false, order: 3, timeoutSeconds: 180 },
      ],
      continueOnError: true,
    },
  );
  // 运行中的项目默认 enabled: true
  assert.deepEqual(
    normalizeStartupPlan(
      {
        projects: [{ directory: 'database', enabled: true, order: 2, timeoutSeconds: 45 }],
        continueOnError: true,
      },
      ['database', 'apps'],
      ['apps'],
    ),
    {
      projects: [
        { directory: 'database', enabled: true, order: 2, timeoutSeconds: 45 },
        { directory: 'apps', enabled: true, order: 3, timeoutSeconds: 180 },
      ],
      continueOnError: true,
    },
  );
  assert.throws(() => normalizeStartupPlan({ projects: [
    { directory: 'database', enabled: true, order: 1 },
    { directory: 'apps', enabled: true, order: 1 },
  ] }, ['database', 'apps']));
});

void test('generates valid host shell scripts in forward and reverse order', () => {
  const plan = normalizeStartupPlan({ projects: [
    { directory: 'database', enabled: true, order: 1, timeoutSeconds: 60 },
    { directory: 'apps', enabled: true, order: 2, timeoutSeconds: 90 },
  ] }, ['database', 'apps']);
  const runtime = [
    { name: 'database', directory: 'database', hostFile: "/srv/compose/database/docker-compose.yml" },
    { name: 'apps', directory: 'apps', hostFile: "/srv/compose/apps/docker-compose.yml" },
  ];
  const startup = generateStartupScript(plan, runtime, '/var/lib/docker-manager/status.json', '/var/log/docker-manager.log');
  const restart = generateRestartScript(plan, runtime, '/var/lib/docker-manager/status.json', '/var/log/docker-manager.log');
  assert.equal(spawnSync('/bin/sh', ['-n'], { input: startup }).status, 0);
  assert.equal(spawnSync('/bin/sh', ['-n'], { input: restart }).status, 0);
  assert.ok(startup.indexOf("-p 'database'") < startup.indexOf("-p 'apps'"));
  assert.ok(restart.indexOf("-p 'apps'") < restart.indexOf("-p 'database'"));
  assert.match(generateStartupUnit(), /WantedBy=docker\.service/);
});
