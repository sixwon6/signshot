/**
 * Album field rules, matching the program's `validate_album` (`InvalidAlbum`, 6004). Group fields
 * are mutable, so this reports rather than refuses; only the creation path in `album.ts` throws.
 * JS `trim` strips a superset of Rust's `str::trim` whitespace, and the extra U+FEFF is unsafe anyway.
 */

import { hasUnsafeText } from "./details";

/** `https://arweave.net/` + 43 URL-safe characters. The dot is escaped so only that host matches. */
const ARWEAVE = /^https:\/\/arweave\.net\/[A-Za-z0-9_-]{43}$/;

interface AlbumConformance {
  conforming: boolean;
  /** A sentence naming the first thing that is wrong. Absent when conforming. */
  reason?: string;
}

const utf8Length = (value: string) => new TextEncoder().encode(value).length;

/**
 * Is this group's content what a Seedshot album looks like?
 *
 * Accepts a bare `{ name, uri }` as well as a decoded group, so the creation path can check a
 * name the user is still typing against the same rule the chain will apply.
 */
export function albumConformance(group: {
  name: string;
  uri: string;
  groups?: readonly unknown[];
  parentGroups?: readonly unknown[];
  assets?: readonly unknown[];
  plugins?: readonly unknown[];
  /** `decodeGroup` found a plugin area it could not decode. Content, like the rest. */
  unknownPlugins?: boolean;
}): AlbumConformance {
  const fail = (reason: string) => ({ conforming: false, reason });
  if (
    !group.name ||
    group.name.trim() !== group.name ||
    utf8Length(group.name) > 32 ||
    hasUnsafeText(group.name)
  )
    return fail(
      "Use an album name of 1 to 32 bytes, with no leading or trailing spaces and no invisible characters.",
    );
  if (group.uri && !ARWEAVE.test(group.uri))
    return fail("An album reference must be empty or an Arweave document.");
  // A Seedshot album is a flat list of photo editions. A nested group, a parent group or a
  // directly attached asset is somebody's other Core object; the page can list the member
  // photographs it does understand and say so, rather than pretending to model the rest.
  if (group.groups?.length || group.parentGroups?.length)
    return fail("This Core group is nested inside or above other groups.");
  if (group.assets?.length)
    return fail("This Core group holds assets directly, which a Seedshot album never does.");
  // An undecodable plugin area is reported like a decodable one: either way this is not the
  // flat, plugin-free list `create_album` writes.
  if (group.plugins?.length || group.unknownPlugins)
    return fail("This Core group carries a plugin, which a Seedshot album never does.");
  return { conforming: true };
}
