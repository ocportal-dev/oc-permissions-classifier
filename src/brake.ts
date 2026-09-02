const REASON_DELETE = "recursive force-delete of the root or home directory"
const REASON_FORK_BOMB = "shell fork bomb"
const REASON_DISK = "disk format or raw device overwrite"
const REASON_EXFILTRATION = "possible credential exfiltration over the network"

/** Command prefixes that only change how the real command runs. */
const WRAPPER = /^(sudo|doas|env|command|nice|nohup|time)\b/
/** A wrapper flag that takes its own argument. */
const FLAG_WITH_ARGUMENT = /^(-u|-g|-n|--user|--group)$/
const WRAPPER_FLAG = /^(--[A-Za-z][A-Za-z0-9-]*|-[A-Za-z0-9]+)(\s|$)/
const ENVIRONMENT_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=\S*(\s|$)/
const SHELL_COMMAND = /^(?:sh|bash|zsh)\s+-[A-Za-z]*c\s+(?:'([\s\S]*)'|"([\s\S]*)")\s*$/
const SEPARATOR = /\|\||&&|[;|&\n\r]/
/** Grouping and control-flow tokens that only wrap the real command. */
const BLOCK_PREFIX = /^(?:[({]|(?:then|do|else|if|while|until)\s)\s*/
/** The one closer that pairs with a stripped `(` or `{`. `${HOME}` keeps its own brace. */
const BLOCK_CLOSER = /\s*;?\s*[)}]\s*$/
const TRAILING_SEMICOLON = /[;\s]+$/

const ROOT_OR_HOME = /^(\/|~|\$HOME|\$\{HOME\})\/?\*?$/
const FORK_BOMB = /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/
const DISK_FORMAT = /^mkfs(\.[A-Za-z0-9_.-]+)?\b/
const RAW_DEVICE = /\bof=\/dev\/(sd|nvme|disk|hd|mmcblk)/
const NETWORK_TOOL = /(?:^|[\s;&|(<>])(curl|wget|nc|ncat|socat|scp|rsync)\b/
const CREDENTIAL_PATH =
  /~\/\.ssh|\.ssh\/id_|\bid_rsa\b|\bid_ed25519\b|\.aws\/credentials|\.config\/gh\/hosts\.yml|\.netrc\b|\.npmrc\b|\.docker\/config\.json/

/**
 * Reports why a request must be blocked before the model sees it, or undefined when
 * nothing matches. It reads shell statements only, and it expands nothing: no variables,
 * no globs. A pattern therefore only fires on text that is already there.
 *
 * Out of scope, because the model review still sees them:
 * - `find / -delete` and other tools that delete without calling rm.
 * - `xargs rm -rf /` and anything else that builds the target list at run time.
 * - `rm -rf /home/$USER` and any target that only becomes root or home after expansion.
 * - `rm -rf /.`, which POSIX rm refuses anyway.
 */
export function brakeReason(action: string, resources: readonly string[]): string | undefined {
  if (action !== "shell") return undefined
  for (const resource of resources) {
    for (const statement of statements(resource)) {
      const reason = inspect(statement)
      if (reason) return reason
    }
  }
  return undefined
}

/** The statement itself, plus the body of a `sh -c '...'` wrapper when there is one. */
function statements(resource: string): string[] {
  const outer = stripWrappers(resource)
  const wrapped = SHELL_COMMAND.exec(outer)
  const inner = wrapped?.[1] ?? wrapped?.[2]
  return inner ? [outer, stripWrappers(inner)] : [outer]
}

function inspect(statement: string): string | undefined {
  const commands = statement.split(SEPARATOR).map(stripWrappers).filter(Boolean)
  if (commands.some(isRootDelete)) return REASON_DELETE
  if (FORK_BOMB.test(statement)) return REASON_FORK_BOMB
  if (commands.some(isDiskWrite)) return REASON_DISK
  // A read of a credential file piped into a network tool, such as
  // `cat ~/.ssh/id_rsa | curl ...`, stays inside one statement, so testing the whole
  // statement covers it.
  if (NETWORK_TOOL.test(statement) && CREDENTIAL_PATH.test(statement)) return REASON_EXFILTRATION
  return undefined
}

/**
 * Removes leading wrapper commands, their flags, their environment assignments, and the
 * grouping or control-flow tokens around them.
 */
function stripWrappers(input: string): string {
  let rest = input.trim().replace(TRAILING_SEMICOLON, "")
  for (;;) {
    const block = BLOCK_PREFIX.exec(rest)
    if (block) {
      rest = rest.slice(block[0].length).trim()
      if (block[0].startsWith("(") || block[0].startsWith("{")) rest = rest.replace(BLOCK_CLOSER, "")
      continue
    }
    if (!WRAPPER.test(rest)) break
    rest = rest.replace(WRAPPER, "").trim()
    for (;;) {
      const flag = WRAPPER_FLAG.exec(rest)
      if (flag) {
        rest = rest.slice(flag[0].length).trim()
        if (FLAG_WITH_ARGUMENT.test(flag[1])) rest = rest.replace(/^\S+\s*/, "").trim()
        continue
      }
      const assignment = ENVIRONMENT_ASSIGNMENT.exec(rest)
      if (assignment) {
        rest = rest.slice(assignment[0].length).trim()
        continue
      }
      break
    }
  }
  return rest
}

/** `rm` itself, or `rm` reached by an absolute path or through a backslash escape. */
const REMOVE_COMMAND = /^(?:\\|(?:\/[\w.\-\/]*\/))?rm\b([\s\S]*)$/

function isRootDelete(command: string): boolean {
  const match = REMOVE_COMMAND.exec(command)
  if (!match) return false

  let recursive = false
  let force = false
  const targets: string[] = []
  for (const token of match[1].split(/\s+/).filter(Boolean)) {
    if (token === "--recursive") recursive = true
    else if (token === "--force") force = true
    else if (token.startsWith("--")) continue
    else if (token.startsWith("-") && token.length > 1) {
      if (/[rR]/.test(token)) recursive = true
      if (/f/.test(token)) force = true
    } else targets.push(token)
  }

  if (!recursive || !force) return false
  return targets.some((target) => ROOT_OR_HOME.test(target.replace(/^['"]+|['"]+$/g, "")))
}

function isDiskWrite(command: string): boolean {
  if (DISK_FORMAT.test(command)) return true
  return /^dd\b/.test(command) && RAW_DEVICE.test(command)
}
