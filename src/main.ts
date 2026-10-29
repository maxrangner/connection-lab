import { fetchWebPage, runScenario } from './sim';

const r = runScenario(fetchWebPage(), { seed: 1 });
document.querySelector('#app')!.textContent = `${r.events.length} events`;
