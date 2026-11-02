/**
 * The vocabulary of a skill.
 *
 * A skill is a *procedure*, not a tool and not an agent: a `SKILL.md` with
 * metadata plus a body that says how to do a repeatable job. Tools are actions
 * the loop executes; a skill is instructions the model follows and may
 * implement with tools that already exist.
 *
 * The distinction is load-bearing. If a skill could add a tool, it would need a
 * permission model of its own; if it could become an agent, it would break ADR
 * 001. Keeping it as text plus files means the existing `ToolPolicy` remains the
 * only thing that can authorize an action.
 *
 * See docs/adr/015-skills.md.
 */

/** Where a skill was found. The order is also discovery precedence. */
export type SkillSource = 'project' | 'agents' | 'builtin';

export interface SkillManifest {
  readonly name: string;
  readonly description: string;
  /**
   * Tools the skill says it needs.
   *
   * Advisory, never a grant. The loop still checks `ToolPolicy`; a skill that
   * says `bash` does not make commands available.
   */
  readonly allowedTools: readonly string[];
  readonly version?: string;
  readonly license?: string;
  readonly metadata: Readonly<Record<string, string>>;
}

export interface Skill {
  readonly manifest: SkillManifest;
  /** Absolute, canonical skill directory. */
  readonly root: string;
  /** Absolute path to `SKILL.md`. */
  readonly entry: string;
  /** The instructions, loaded only when the skill is selected. */
  readonly body: string;
  readonly source: SkillSource;
  /** Short hash of the exact `SKILL.md` bytes, for logs and evaluations. */
  readonly hash: string;
  /** Paths relative to `root`, e.g. `references/matrix.md`. */
  readonly references: readonly string[];
  readonly scripts: readonly string[];
  readonly assets: readonly string[];
}

export interface SkillIndexEntry {
  readonly name: string;
  readonly description: string;
  readonly source: SkillSource;
}

/** A skill directory that could not be used, kept so the failure is visible. */
export interface SkillDiagnostic {
  readonly source: SkillSource;
  /** Path relative to the discovery root, or the absolute path for a root error. */
  readonly path: string;
  readonly reason: string;
}

export type SkillLoadResult =
  | { readonly ok: true; readonly skill: Skill }
  | { readonly ok: false; readonly error: string; readonly available: readonly string[] };
