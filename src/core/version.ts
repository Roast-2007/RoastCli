import packageJson from '../../package.json' with { type: 'json' };

// CLI, prompts and UI share the package version as their single source of truth.
export const VERSION = packageJson.version;
