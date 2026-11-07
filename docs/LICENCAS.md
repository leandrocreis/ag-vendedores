# Licenças, atribuições e obrigações

Este projeto **não** inclui cópias do código dos oito repositórios: eles são baixados em `vendor/` (ignorado pelo Git) nos commits de `refs.lock.json`. As exceções copiadas para o repositório estão listadas abaixo com suas licenças.

## Copiado para este repositório
| Item | Origem | Licença | Onde |
|---|---|---|---|
| Skill `sound-effects` (SKILL.md, scripts, sons CC0 em `sfx/`) | Barty-Bart/motion-graphics @`3d83d98` | MIT (código); sons CC0 1.0 | `.claude/skills/sound-effects/`, `.claude/skills/LICENSE-motion-graphics` |
| 11 skills `yt-*` | Jakeschincariol/youtube-agent-skill @`a2feb21` | MIT | `.claude/skills/yt-*`, `.claude/skills/LICENSE-youtube-agent-skill` |
| Lógica de `hookscore.py`, `title.py`, `chapters.py`, `retention.py`, `deadair.py`, `swipe.py` (portada para TypeScript, com léxico em português acrescentado) | youtube-agent-skill | MIT | `server/src/editorial/yt-tools.ts` |
| Três whooshes | Freesound via Openverse | CC0 1.0 (2) e CC BY 3.0 (1) — ver `sons/CREDITOS.txt` | `sons/` |

A abordagem do “sound pass” é creditada pela skill a Vox (@Voxyz_ai); o crédito é mantido.

## Estilos do Lemo-Opuscar
O código é MIT; **demos e stills são CC BY 4.0** (crédito a LemoLab com link e indicação de alterações). Usamos nomes, descrições, prompts de estilo (STYLE.md) e miniaturas para o catálogo e como direção de arte. A descrição gerada pelo app inclui a atribuição do estilo quando um estilo do Lemo é usado. **Seis faixas de voz das demos não são CC BY** e nunca são reutilizadas (o app só faz streaming do filme demo para visualização). A coleção OPUSCAR 98 cita filmes reais e um mascote do autor: o app mostra aviso para usar só a técnica.

## VoiceStudio (AGPL-3.0-only)
O E Se? Studio **não inclui, não modifica e não redistribui** código do VoiceStudio: comunica-se com uma instalação do próprio usuário pela API HTTP local documentada. Ainda assim, não apresentamos esse adaptador como dispensa automática de obrigações: se você **modificar** o VoiceStudio e oferecê-lo a outras pessoas pela rede, a AGPL exige oferecer o código-fonte correspondente; se distribuir um pacote que o inclua, cumpra a AGPL nessa distribuição. Os **pesos** têm termos próprios: o padrão `k2-fsa/OmniVoice` declara código Apache-2.0 e **pesos CC-BY-NC (uso não comercial)**, e o tokenizer traz termos Higgs Audio 2 e Llama. Para vídeos monetizados, escolha no VoiceStudio um motor cujos pesos permitam uso comercial, ou use o Kokoro (Apache-2.0).

## Open-Higgsfield-AI
O README declara MIT, mas o commit verificado **não contém arquivo LICENSE**. Nenhum código dele foi copiado; a integração Muapi não foi implementada.

## Modelos usados localmente
- Kokoro-82M v1.0 — Apache-2.0 (via kokoro-onnx, MIT).
- faster-whisper (MIT) com modelos Whisper (MIT).
- Wan2.1-T2V-1.3B — Apache-2.0 (opcional, cenas por IA).

## O que a licença do código NÃO autoriza
Licença de código não é autorização automática de uso comercial de modelos, pesos, mídias ou serviços. Verifique os termos dos provedores (OpenAI, Anthropic, RunPod) e a página de cada som antes de publicar. O catálogo Openverse não garante ausência de reivindicações de terceiros.
