import { describe, it, expect } from 'vitest';
import { isChatModel, qualityScore, MODEL_FETCHERS } from '../electron/ai-discovery';
import { AI_PROVIDERS } from '../electron/ai';

describe('isChatModel', () => {
  it('accepte les modèles de chat courants', () => {
    for (const id of [
      'gemini-2.5-flash', 'gemini-flash-lite-latest', 'llama-3.3-70b-versatile',
      'deepseek-ai/deepseek-v4-flash', 'Meta-Llama-3.3-70B-Instruct', 'qwen/qwen3-32b',
    ]) {
      expect(isChatModel(id), id).toBe(true);
    }
  });

  it('rejette les modèles non-chat', () => {
    for (const id of [
      'text-embedding-004', 'nvidia/llama-3.2-nemoretriever-300m-embed-v1',
      'stabilityai/stable-diffusion-xl', 'meta/llama-guard-3-8b',
      'google/deplot', 'nvidia/neva-22b',
    ]) {
      expect(isChatModel(id), id).toBe(false);
    }
  });
});

describe('qualityScore', () => {
  it('ordonne les gammes Gemini correctement', () => {
    const pro = qualityScore('gemini-2.5-pro', null);
    const flash = qualityScore('gemini-2.5-flash', null);
    const lite = qualityScore('gemini-2.5-flash-lite', null);
    expect(pro).toBeGreaterThan(flash);
    expect(flash).toBeGreaterThan(lite);
    expect(lite).toBeGreaterThan(0);
  });

  it('les alias "-latest" matchent comme le nom canonique', () => {
    expect(qualityScore('gemini-flash-lite-latest', null))
      .toBe(qualityScore('gemini-9.9-flash-lite', null));
  });

  it('un grand contexte ajoute un bonus', () => {
    expect(qualityScore('gemini-2.5-flash', 1_000_000))
      .toBeGreaterThan(qualityScore('gemini-2.5-flash', null));
  });

  it('un modèle inconnu a un score de base faible', () => {
    expect(qualityScore('zz-unknown-model-9000', null)).toBeLessThan(
      qualityScore('llama-3.3-70b', null));
  });
});

describe('MODEL_FETCHERS', () => {
  it('un fetcher par provider', () => {
    for (const p of AI_PROVIDERS) {
      expect(typeof MODEL_FETCHERS[p]).toBe('function');
    }
  });
});
