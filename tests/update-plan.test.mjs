import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  composeConfigMatches,
  composeUpgradeCommands,
  isManagerContainer,
} from '../lib/update-plan.ts';
import { parseRegistryReference, registryCandidates } from '../lib/registry-reference.ts';

void test('updates one Compose service only after its image was pulled', () => {
  assert.deepEqual(composeUpgradeCommands('api-server'), [
    ['pull', 'api-server'],
    ['up', '-d', '--no-deps', 'api-server'],
  ]);
  assert.throws(() => composeUpgradeCommands('../invalid'));
});

void test('recognizes the manager container without depending on a leading slash', () => {
  assert.equal(isManagerContainer('/docker-manager', 'docker-manager'), true);
  assert.equal(isManagerContainer('nginx', 'docker-manager'), false);
});

void test('matches mounted Compose files against their original host path', () => {
  assert.equal(
    composeConfigMatches('media/jellyfin', '/vol5/docker/compose/media/jellyfin/docker-compose.yml'),
    true,
  );
  assert.equal(
    composeConfigMatches('media/jellyfin', '/vol5/docker/compose/other/docker-compose.yml'),
    false,
  );
});

void test('uses Docker Hub mirrors only for Docker Hub images', () => {
  assert.deepEqual(
    registryCandidates(parseRegistryReference('nginx:latest'), [
      'https://mirror.example.com/',
      'https://mirror.example.com',
    ]),
    ['https://mirror.example.com', 'https://registry-1.docker.io'],
  );
  assert.deepEqual(
    registryCandidates(parseRegistryReference('registry.example.com/team/api:latest'), [
      'https://mirror.example.com',
    ]),
    ['https://registry.example.com'],
  );
});
