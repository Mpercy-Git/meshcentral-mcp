import fs from 'fs';
import path from 'path';

// Local filesystem jail for the two tools that touch the MCP host's own disk
// (mesh_file_download writes to it, mesh_file_upload reads from it).
//
// Without this, an agent driving those tools has arbitrary read/write on the
// machine running the MCP server - including this server's own .env, the user's
// SSH keys and shell profiles. Everything else in this codebase only ever
// touches remote devices.

const DEFAULT_ROOT = 'mcp-files';
const UNRESTRICTED = '*';

let resolvedRoot;           // realpath of the jail, or null when unrestricted
let warnedUnrestricted = false;

function isInside(root, target) {
  if (target === root) return true;
  const rel = path.relative(root, target);
  return rel !== '' && !rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel);
}

// Walk up until we find a path that exists, and return its real (symlink-resolved)
// location. A symlinked ancestor is how an otherwise-contained path escapes the jail.
function realpathOfNearestExisting(target) {
  let current = target;
  for (;;) {
    try {
      return fs.realpathSync(current);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      const parent = path.dirname(current);
      if (parent === current) throw new Error(`Cannot resolve any part of '${target}'`);
      current = parent;
    }
  }
}

// The jail root, created on first use. Returns null when the operator has
// explicitly opted out with MESH_LOCAL_FILE_ROOT=*.
export function localFileRoot() {
  if (resolvedRoot !== undefined) return resolvedRoot;

  const configured = process.env.MESH_LOCAL_FILE_ROOT || DEFAULT_ROOT;
  if (configured === UNRESTRICTED) {
    if (!warnedUnrestricted) {
      warnedUnrestricted = true;
      console.error(
        '[meshcentral-mcp] WARNING: MESH_LOCAL_FILE_ROOT=* - local file access is unrestricted. ' +
          'mesh_file_download can write anywhere this process can write, and mesh_file_upload can read ' +
          'any file it can read.'
      );
    }
    resolvedRoot = null;
    return resolvedRoot;
  }

  const target = path.resolve(configured);
  fs.mkdirSync(target, { recursive: true });
  resolvedRoot = fs.realpathSync(target);
  return resolvedRoot;
}

/**
 * Resolve a caller-supplied local path, confining it to the jail.
 *
 * Relative paths resolve against the jail root rather than the process working
 * directory, so 'report.txt' lands inside the jail rather than next to the source.
 *
 * @param {string} rawPath         path as supplied by the tool caller
 * @param {object} [opts]
 * @param {boolean} [opts.mustExist]  require the path to exist (upload source)
 * @returns {string} an absolute path that is safe to open
 */
export function resolveLocalPath(rawPath, { mustExist = false } = {}) {
  if (typeof rawPath !== 'string' || rawPath.length === 0) {
    throw new Error('A local path is required');
  }

  const root = localFileRoot();
  if (root === null) {
    const unrestricted = path.resolve(rawPath);
    if (mustExist && !fs.existsSync(unrestricted)) {
      throw new Error(`Local file not found: ${unrestricted}`);
    }
    return unrestricted;
  }

  // path.resolve collapses '..', so the result carries no traversal segments.
  const resolved = path.resolve(root, rawPath);
  if (!isInside(root, resolved)) {
    throw new Error(
      `Local path '${rawPath}' is outside the permitted directory (${root}). ` +
        'Local file access is confined to that directory; set MESH_LOCAL_FILE_ROOT to move it.'
    );
  }

  // Re-check after following symlinks, so a link planted inside the jail cannot
  // redirect the operation outside it.
  const realAncestor = realpathOfNearestExisting(resolved);
  if (!isInside(root, realAncestor)) {
    throw new Error(
      `Local path '${rawPath}' resolves outside the permitted directory (${root}) via a symbolic link.`
    );
  }

  if (mustExist) {
    if (!fs.existsSync(resolved)) {
      throw new Error(`Local file not found: ${resolved}`);
    }
    const real = fs.realpathSync(resolved);
    if (!isInside(root, real)) {
      throw new Error(
        `Local path '${rawPath}' resolves outside the permitted directory (${root}) via a symbolic link.`
      );
    }
    return real;
  }

  return resolved;
}
