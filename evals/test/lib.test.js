import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectLanguage, includesFacts, wer, compareToBaseline } from '../lib.js';

test('detectLanguage', () => {
  assert.equal(detectLanguage('آپ کا آرڈر تیار ہے'), 'ur');
  assert.equal(detectLanguage('طلبك جاهز، شكرا لك'), 'ar');
  assert.equal(detectLanguage('आपका ऑर्डर तैयार है'), 'hi');
  assert.equal(detectLanguage('Ji haan, aap ka order kal tak pohanch jayega'), 'roman-ur');
  assert.equal(detectLanguage('Your order will arrive tomorrow, thank you'), 'en');
  assert.equal(detectLanguage('Hola, su pedido está listo, gracias'), 'es');
  assert.equal(detectLanguage('Olá, seu pedido está pronto, obrigado'), 'pt');
});

test('includesFacts', () => {
  assert.equal(includesFacts('Fee is Rs 1500', [['1500', '۱۵۰۰']]), true);
  assert.equal(includesFacts('Fee is Rs 1000', [['1500']]), false);
});

test('wer', () => {
  assert.equal(wer('mera order kab aayega', 'mera order kab aayega'), 0);
  assert.equal(wer('mera order kab aayega', 'mera order kab'), 0.25);
});

test('compareToBaseline', () => {
  const base = { language_match: 0.9, safety_recall: 0.9, chat_p95_ms: 10000, wer: 0.3 };
  assert.deepEqual(compareToBaseline({ language_match: 0.95, safety_recall: 0.9, chat_p95_ms: 10500, wer: 0.25 }, base), []);
  assert.equal(compareToBaseline({ language_match: 0.85, safety_recall: 0.9, chat_p95_ms: 20000, wer: 0.4 }, base).length, 3);
});
