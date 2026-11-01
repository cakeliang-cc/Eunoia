/**
 * The skill layer's public surface.
 *
 * Skills are read-only text plus files. Nothing here imports a vendor SDK or a
 * tool, which is what keeps `SKILL.md` a document rather than another execution
 * surface.
 */

export type {
  Skill,
  SkillDiagnostic,
  SkillIndexEntry,
  SkillLoadResult,
  SkillManifest,
  SkillSource,
} from './types.ts';
export {
  MAX_BODY_CHARS,
  MAX_DESCRIPTION_CHARS,
  RECOMMENDED_BODY_CHARS,
  SKILL_NAME_PATTERN,
  SkillParseError,
  parseSkillDocument,
} from './parse.ts';
export type { ParsedSkill } from './parse.ts';
export {
  SkillRegistry,
  discoverSkillRegistry,
} from './registry.ts';
export type { SkillDiscoveryOptions, SkillRoot } from './registry.ts';
