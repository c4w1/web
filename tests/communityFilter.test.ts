import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  canAudienceAccess,
  communityDisplay,
  communityGeoKeys,
  matchesCommunity,
  normalizeAudience,
  roleView,
  topicalTags,
  visibleAudiences,
  type CatalogEntryData,
  type CommunityGeo,
} from '../src/lib/data/communityFilter.ts';

const knox: CommunityGeo = {
  slug: 'knox-county',
  state_code: 'TN',
  county: 'Knox County',
  county_fips: '47093',
};

const davidson: CommunityGeo = {
  slug: 'nashville',
  state_code: 'TN',
  county: 'Davidson County',
  county_fips: '47037',
};

function entry(overrides: Partial<CatalogEntryData> = {}): CatalogEntryData {
  return {
    tags: [],
    dataThemes: ['education'],
    pedagogicalTags: ['data-literacy'],
    audienceAccess: { teacher: true, student: true, community: true },
    sensitive: false,
    ...overrides,
  };
}

// ── Geographic filtering ────────────────────────────────────────────────────

test('communityGeoKeys includes slug, FIPS key, and county-name key', () => {
  assert.deepEqual(communityGeoKeys(knox).sort(), ['fips-47093', 'knox-county']);
  assert.deepEqual(communityGeoKeys(davidson).sort(), [
    'davidson-county',
    'fips-47037',
    'nashville',
  ]);
});

test('matchesCommunity matches by county FIPS tag', () => {
  assert.equal(matchesCommunity(entry({ tags: ['fips-47093'] }), knox), true);
  assert.equal(matchesCommunity(entry({ tags: ['fips-47093'] }), davidson), false);
});

test('matchesCommunity matches by slug or county-name tag, case-insensitively', () => {
  assert.equal(matchesCommunity(entry({ tags: ['knox-county'] }), knox), true);
  assert.equal(matchesCommunity(entry({ tags: ['Davidson County'] }), davidson), true);
  assert.equal(matchesCommunity(entry({ tags: ['nashville'] }), davidson), true);
});

test('matchesCommunity does not match other places or untagged entries', () => {
  assert.equal(matchesCommunity(entry({ tags: ['knox-county', 'tennessee'] }), davidson), false);
  assert.equal(matchesCommunity(entry({ tags: ['dataset', 'government-data'] }), knox), false);
  assert.equal(matchesCommunity(entry({ tags: [] }), knox), false);
});

test('matchesCommunity works for a community with only slug and state', () => {
  const minimal: CommunityGeo = { slug: 'oak-ridge', state_code: 'TN' };
  assert.equal(matchesCommunity(entry({ tags: ['oak-ridge'] }), minimal), true);
  assert.equal(matchesCommunity(entry({ tags: ['knox-county'] }), minimal), false);
});

// ── Role views ──────────────────────────────────────────────────────────────

test('teacher view shows topical and pedagogical tags', () => {
  assert.deepEqual(roleView(entry(), 'teacher'), {
    visible: true,
    showTopicalTags: true,
    showPedagogicalTags: true,
  });
});

test('community member view shows topical tags but not pedagogical tags', () => {
  assert.deepEqual(roleView(entry(), 'community'), {
    visible: true,
    showTopicalTags: true,
    showPedagogicalTags: false,
  });
});

test('student view hides sensitive datasets but other roles still see them', () => {
  const crime = entry({ sensitive: true, dataThemes: ['law-public-safety'] });
  assert.equal(roleView(crime, 'student').visible, false);
  assert.equal(roleView(crime, 'teacher').visible, true);
  assert.equal(roleView(crime, 'community').visible, true);
  assert.equal(roleView(crime, 'student').showPedagogicalTags, false);
});

test('student view hides datasets marked not student-friendly', () => {
  const hidden = entry({ audienceAccess: { teacher: true, student: false, community: true } });
  assert.equal(canAudienceAccess(hidden, 'student'), false);
  assert.equal(visibleAudiences(hidden), 'teacher community');
});

test('student view hides addiction/drug themed datasets (existing keyword rule)', () => {
  assert.equal(canAudienceAccess(entry({ dataThemes: ['addiction-recovery'] }), 'student'), false);
  assert.equal(canAudienceAccess(entry({ tags: ['opioid-deaths'] }), 'student'), false);
  assert.equal(canAudienceAccess(entry({ tags: ['opioid-deaths'] }), 'community'), true);
});

test('student-friendly datasets are visible to every role', () => {
  assert.equal(visibleAudiences(entry()), 'teacher student community');
});

// ── Helpers ─────────────────────────────────────────────────────────────────

test('normalizeAudience accepts known roles and the legacy community_member alias', () => {
  assert.equal(normalizeAudience('teacher'), 'teacher');
  assert.equal(normalizeAudience(' Student '), 'student');
  assert.equal(normalizeAudience('community_member'), 'community');
  assert.equal(normalizeAudience('admin'), null);
  assert.equal(normalizeAudience(null), null);
});

test('topicalTags falls back to non-geographic tags when themes are empty', () => {
  const e = entry({ dataThemes: [], tags: ['knox-county', 'education', 'fips-47093'] });
  assert.deepEqual(topicalTags(e, knox), ['education']);
  assert.deepEqual(topicalTags(entry(), knox), ['education']);
});

test('communityDisplay derives heading and library title from place_name', () => {
  assert.deepEqual(
    communityDisplay({ name: 'Knox County Data Library', place_name: 'Knoxville' }),
    {
      placeName: 'Knoxville',
      libraryTitle: 'Knoxville Community Data Library',
      welcomeHeading: 'Welcome to Knoxville',
    }
  );
});

test('communityDisplay falls back to the library name without place_name', () => {
  assert.deepEqual(communityDisplay({ name: 'Oak Ridge Data Library' }), {
    placeName: 'Oak Ridge Data Library',
    libraryTitle: 'Oak Ridge Data Library',
    welcomeHeading: 'Welcome to Oak Ridge Data Library',
  });
});
