import { readFile, readdir, writeFile } from 'node:fs/promises';
export async function notices() {
  const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
  const sections = ['Echo Room — third-party package notices\nGenerated from the locked installation. Original dependencies retain their licenses.\n'];
  for (const [path, pkg] of Object.entries(lock.packages)) {
    if (!path.startsWith('node_modules/')) continue;
    const name = path.split('node_modules/').at(-1);
    let license = '';
    try { const files = await readdir(path); const file = files.find(f => /^(license|licence|copying)(\.(md|txt))?$/i.test(f)); if (file) license = await readFile(`${path}/${file}`, 'utf8'); } catch { /* Other-platform optional dependencies are not installed. */ }
    sections.push(`\n--- ${name} ${pkg.version} (${pkg.license || 'see upstream package'}) ---\n${license || 'See the distributed npm package for the complete license text.'}`);
  }
  await writeFile('dist/THIRD-PARTY-NOTICES.txt', sections.join('\n'));
}
