# Projeto demonstrativo — “A Clareira do Silêncio”

Premissa: *E se um apocalipse zumbi começasse enquanto você estivesse acampando?* · pacote (longo de 7 min + 3 curtos de 45–60 s) · estilo autoral “Cartoon narrativo cinematográfico” · animação por código · **sem cenas por IA** · orçamento US$ 5 (nenhum gasto até agora).

## O que já foi feito (de verdade)
1. **Roteiro pelo caminho B (Claude Code).** O app preparou `data/projetos/p84a6409010fc2b3/claude-code/`; o roteiro foi escrito nessa pasta por uma sessão do Claude Code e importado pelo botão “Importar resultados” (validação de schema). Gancho, personagens (Você, Bia, Téo, Rafael), três regras do mundo descobertas pela experiência (som atrai; água encobre; mordida transforma em minutos) e três decisões com consequência (bota como distração; rio em vez de cascalho; trancar o Rafael na cabana), resolução e CTA ligada ao dilema.
2. **Calibração da voz:** Kokoro `pm_alex` a 0,9× medido em ~179 palavras/min → meta de ~1.146 palavras.
3. **Narração v1 (master real):** 458,9 s — **39 s acima** da meta de 420 ± 20 s.
4. **Revisão do roteiro (v2):** 13 falas encurtadas (−78 palavras), sem acelerar a voz nem mexer em pausas. **Só os 13 trechos alterados foram ressintetizados**; 41 vieram do cache por conteúdo.
5. **Narração v2:** **433,7 s (7:14)**, dentro da meta. WAV 48 kHz/24 bit, −20,1 LUFS de nivelamento. Elenco: narrador `pm_alex` 0,9×; Bia `pf_dora`; Téo `pm_santa`; Rafael = mistura real de embeddings 50% `pm_alex` + 50% `pm_santa`, 0,85×.

## Onde parou — de propósito
A narração v2 está **aguardando a sua aprovação**. O backend recusa storyboard, cenas e montagem até lá (testado: resposta 409 com “Gerar e aprovar narração”). Nenhuma imagem, cena ou edição de produção foi feita para este projeto.

## Próximos passos (no app)
1. Projeto → **Voz e narração** → ouça o master v2 inteiro (há também `A_Clareira_do_Silencio_narracao_v2_PARA_APROVAR.mp3` entregue na conversa). Ajuste trechos se quiser (cada mudança gera nova versão).
2. **Aprovar áudio e iniciar cenas** → **Transcrever e alinhar a gravação**.
3. **Storyboard e cenas** → **Gerar storyboard sincronizado** → **Renderizar cena piloto** (cena 1) para validar o estilo antes do lote.
4. **Exportação** → **Montar e exportar** (gera também os 5 trechos de fone e o `RELATORIO_SOM.html`).
5. **Curtos** → escolha 3 sugestões de 45–60 s → cada curto monta e aprova o próprio master → exporta 1080×1920.
Nenhuma etapa paga é necessária neste projeto (voz, render e montagem são locais).
