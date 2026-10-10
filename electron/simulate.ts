/**
 * Simulation de tri : teste le système de failover IA sans Gmail.
 * Simule 50 emails avec des providers qui se font rate-limiter.
 *
 * Usage : npx tsx electron/simulate.ts
 */
import { categorize, initProviders, getProviderStats, onCategorizeAttempt } from './ai';

// Simule 50 emails à trier.
const MOCK_EMAILS = Array.from({ length: 50 }, (_, i) => ({
  from: `sender${i}@example.com`,
  to: 'me@gmail.com',
  subject: `Email test ${i}`,
  body: `Ceci est le corps de l'email ${i}. Newsletter promotionnelle avec facture.`,
  categories: [
    { id: 'travail', name: 'Travail' },
    { id: 'personnel', name: 'Personnel' },
    { id: 'factures', name: 'Factures' },
    { id: 'promotions', name: 'Promotions' },
    { id: 'spam', name: 'Spam' },
    { id: 'autre', name: 'Autre' },
  ],
}));

async function main() {
  console.log('=== SIMULATION DE TRI ===\n');

  // Initialise avec des clés factices (les vraies requêtes échoueront,
  // ce qui testera le failover et le cooldown).
  initProviders({
    openrouterApiKey: 'sk-fake-openrouter-key',
    nvidiaApiKey: 'nvapi-fake-nvidia-key',
    groqApiKey: 'gsk-fake-groq-key',
    geminiApiKey: 'AIza-fake-gemini-key',
    sambanovaApiKey: null,
    cerebrasApiKey: null,
    providerModels: {},
    providerModelQueue: {},
  });

  // Callback pour voir les tentatives en temps réel.
  onCategorizeAttempt((info) => {
    const status = info.success ? '✓' : '✗';
    const model = info.model ? `/${info.model}` : '';
    console.log(`  [provider] ${info.provider}${model} ${status} ${info.latencyMs}ms${info.error ? ' — ' + info.error.slice(0, 80) : ''}`);
  });

  let succeeded = 0;
  let failed = 0;

  for (let i = 0; i < MOCK_EMAILS.length; i++) {
    console.log(`\n--- Mail ${i + 1}/${MOCK_EMAILS.length} ---`);
    try {
      const result = await categorize(MOCK_EMAILS[i]);
      console.log(`  → ${result.category_id} (${Math.round(result.confidence * 100)}%) — ${result.reason}`);
      succeeded++;
    } catch (e) {
      console.log(`  → ÉCHEC: ${e}`);
      failed++;
    }

    // Stats tous les 10 mails.
    if ((i + 1) % 10 === 0) {
      console.log(`\n[STATS] ${getProviderStats()}`);
    }
  }

  console.log(`\n=== RÉSULTAT ===`);
  console.log(`Réussis: ${succeeded}/${MOCK_EMAILS.length}`);
  console.log(`Échoués: ${failed}/${MOCK_EMAILS.length}`);
  console.log(`Stats finaux: ${getProviderStats()}`);
}

main().catch(console.error);
