/**
 * FIXTURE DE TESTE — roteiro curto escrito à mão para testes automatizados.
 * NÃO é saída de modelo e não comprova a integração com a API Anthropic.
 */
export const FIXTURE_SCRIPT = {
  title: "Teste — barraca à meia-noite",
  logline: "Fixture de teste do pipeline.",
  hook: "Você acorda com o zíper da sua barraca abrindo sozinho.",
  hookOptions: [
    { text: "Você acorda com o zíper da sua barraca abrindo sozinho.", formula: "In Medias Res" },
    { text: "São três da manhã e alguém chama o seu nome do lado de fora da barraca.", formula: "Specific Time" },
    { text: "O rádio do acampamento só repete uma frase: não saia da barraca.", formula: "Mystery" },
    { text: "Você tem doze minutos até a lanterna apagar de vez.", formula: "Countdown" },
    { text: "Ninguém no acampamento respondeu quando você gritou.", formula: "Question" },
  ],
  protagonistGoal: "Chegar ao carro.", stakes: "Ficar presa no escuro.",
  worldRules: ["Eles seguem o som."],
  characters: [{ id: "voce", name: "Você", role: "protagonista", physical: "adulto", clothes: "jaqueta", colors: ["#c0392b", "#2f3d52", "#e0b896", "#3b2a20"], proportions: "normal", accessories: ["lanterna"], personality: "teimosa", relations: "sozinha" }],
  settings: [{ id: "acampamento", description: "clareira com barraca e fogueira" }, { id: "estrada", description: "estrada de terra com o carro" }],
  scenes: [
    { key: "s01", act: 1, goal: "gancho", setting: "acampamento", characters: ["voce"], actions: ["olha para a entrada da barraca"], emotion: "suspense", lines: [
      { speaker: "narrador", text: "Você acorda com o zíper da sua barraca abrindo sozinho.", emotion: "suspense", pauseAfterMs: 600 },
      { speaker: "narrador", text: "Lá fora, a fogueira ainda estala, mas ninguém responde quando você chama.", emotion: "medo", pauseAfterMs: 400 }],
      visualIntent: "barraca iluminada pela fogueira à noite", camera: "push-in lento", mediaNeeds: [], soundMoments: ["estalo da fogueira"], estimatedSeconds: 8 },
    { key: "s02", act: 2, goal: "fuga", setting: "estrada", characters: ["voce"], actions: ["corre até o carro com a lanterna"], emotion: "urgência", lines: [
      { speaker: "narrador", text: "Então você corre pela trilha até a estrada, com a lanterna tremendo na mão.", emotion: "urgência", pauseAfterMs: 500 },
      { speaker: "narrador", text: "O carro está lá. E alguém está sentado no banco do motorista.", emotion: "revelação", pauseAfterMs: 800 }],
      visualIntent: "estrada escura, carro parado, revelação", camera: "travelling e push-in na revelação", mediaNeeds: [], soundMoments: ["passos", "revelação"], estimatedSeconds: 9 },
  ],
  conclusion: "Teste.", cta: "Comente o que você faria.", estimatedWords: 60,
  selfReview: { repetitions: [], contradictions: [], excessiveExposition: [], unkeptPromises: [] },
};
