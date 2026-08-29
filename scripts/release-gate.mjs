import { spawnSync } from 'node:child_process';

const commands = [
  ['npm', ['run', 'format:check']],
  ['npm', ['run', 'typecheck']],
  ['npm', ['test']],
  ['npm', ['run', 'build']],
  ['npm', ['run', 'probe']],
  ['node', ['scripts/check-benchmark.mjs']],
  ['npm', ['run', 'demo']],
  ['node', ['scripts/check-package.mjs']],
  ['node', ['scripts/check-licenses.mjs']],
  ['node', ['scripts/check-disclosure.mjs']]
];

for (const [command, args] of commands) {
  process.stdout.write(`\n> ${command} ${args.join(' ')}\n`);
  const result =
    process.platform === 'win32' && command === 'npm'
      ? spawnSync(
          process.env.ComSpec ?? 'cmd.exe',
          ['/d', '/s', '/c', `${command} ${args.join(' ')}`],
          { encoding: 'utf8' }
        )
      : spawnSync(command, args, { encoding: 'utf8' });
  if (result.error) throw result.error;
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  if (result.status !== 0) process.exit(result.status ?? 1);
}

process.stdout.write('\nRelease gate passed.\n');
