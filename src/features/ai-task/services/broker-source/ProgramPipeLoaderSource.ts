/**
 * How the broker, guard and watchdog programs reach their node on Windows.
 *
 * Elsewhere each program is the single `-e` argument of its node. Windows caps
 * a whole command line at 32,767 characters, and the broker (~120 KB), guard
 * (~35 KB) and watchdog (~32 KB) do not fit. On Windows the `-e` argument is
 * this loader instead, and the parent writes the program into an extra pipe
 * the child inherits as `fd`. The loader runs it once the pipe ends.
 *
 * The program still never touches the disk or the environment, as with `-e`.
 * It runs with the loader's `require`, `module` and `exports`, so it sees the
 * same globals it does under `-e`; `process.argv` is unchanged too.
 *
 * Kept plain ES2018 and short: the broker carries it to start the guard and
 * watchdog, and every byte counts against the broker's Linux argv budget
 * (tests/features/ai-task/broker-source/broker-source-budget.test.ts).
 */
export const PROGRAM_PIPE_LOADER_TEMPLATE =
  "'use strict';const s=new(require('net').Socket)({fd:FD,readable:true,writable:false}),c=[];" +
  "s.on('data',d=>{c.push(d)});s.on('end',()=>{s.destroy();" +
  "new Function('require','module','exports',Buffer.concat(c).toString('utf8'))(require,module,exports)})"

/** The `-e` text that runs the program written to the child's `fd`. */
export function programPipeLoader(fd: number): string {
  return PROGRAM_PIPE_LOADER_TEMPLATE.replace('FD', String(fd))
}

/** The same function, spliced into the broker program. */
export const PROGRAM_PIPE_LOADER_SOURCE =
  `const programPipeLoader = fd => ${JSON.stringify(PROGRAM_PIPE_LOADER_TEMPLATE)}.replace('FD', fd);`
