# Limitações reais e verificações pendentes

Atualizado em 2026-11-07. Ambiente de desenvolvimento: Linux, 4 CPUs, 15 GB RAM, sem GPU, sem chaves de API.

## Verificações reais pendentes (implementado, não exercitado aqui)
| Item | Por quê | Como verificar |
|---|---|---|
| Roteiro pela API Anthropic (caminho A) | sem `ANTHROPIC_API_KEY` | Configurações → Anthropic → Testar; Projeto → Gerar roteiro |
| Imagens OpenAI (fundos, personagens, thumbnail) e modo “camadas” com imagens geradas | sem `OPENAI_API_KEY` | Configurações → OpenAI → Listar modelos / Testar; cena → Planejar imagens |
| Cenas por IA na máquina local | sem GPU NVIDIA | `npm run setup -- --video-local` numa máquina com GPU ≥ 8 GB; Testar local_video |
| Cenas por IA no RunPod | sem chave/endpoint; worker não implantado; contrato (`/run`, `/status`, `/cancel`, `/health`) segue a API Serverless conhecida mas não foi exercitado contra a documentação vigente nem contra um endpoint real | `runpod-worker/README.md` |
| VoiceStudio (vozes, clonagem, voice design, mistura) | não instalado aqui | instalar o VoiceStudio, abrir e “Testar voicestudio” |
| Earshot | instalação e execução de código externo não autorizadas nesta sessão | `npm run setup -- --earshot` |
| `npx skills add Barty-Bart/motion-graphics` | execução do instalador externo não autorizada nesta sessão | skills copiadas manualmente (método alternativo documentado no README do repositório); rode o instalador e escolha `sound-effects` se preferir |
| Ferramentas Python originais da youtube-agent-skill | idem; a lógica foi portada para TypeScript e testada | — |
| Redação das skills yt-package/yt-comment/yt-plan/yt-seo | dependem da chave Anthropic; partes locais funcionam | configurar a chave |
| Projeto demonstrativo: cenas, montagem, curtos, 5 trechos de fone | **aguardam a sua aprovação da narração** (regra central) | `docs/DEMO.md` |

## Limitações de projeto
- **Fidelidade aos estilos do Lemo-Opuscar:** cada estilo original é um filme escrito à mão em código. O nosso motor aproxima o estilo por família de render (16) + paleta real extraída da miniatura + prompt do STYLE.md (usado nas imagens e na direção). Não é o motor do estilo original. Para fidelidade total, use o fluxo do Lemo com o Claude Code.
- **Personagens por código** são bonecos articulados simples (cabeça, tronco, braços e pernas com poses de andar, correr, agachar, olhar, lanterna, cair, estender o braço). Em modo “camadas”, imagens não são articuladas: só deslocamento, escala, parallax e luz.
- **Cenários procedurais** cobrem acampamento, floresta, estrada, rio/lago, cidade e interior de cabana; outros cenários caem no mais próximo. Use imagens (OpenAI ou suas) para cenários fora desse vocabulário.
- **Planos automáticos** do storyboard vêm de regras determinísticas sobre o texto (cenário, luz, ação, câmera); são editáveis por cena e por comando em linguagem natural.
- **Hookscore** é heurística portada (léxico PT acrescentado); em ficção ele tende a dar notas baixas a ganchos bons — use como alerta, não como veredito.
- **Mistura de vozes** real só no Kokoro (vozes do próprio modelo). Português no Kokoro: apenas pt-BR, três vozes; sem emoção, tom ou sotaque controláveis (indicado na interface).
- **Prévias Openverse/Freesound** são MP3 HQ de prévia, não originais sem perdas (registrado nos créditos).
- **Trilha musical** não vem embutida: informe um arquivo com licença (a mixagem faz ducking sob a voz). Sem trilha, o mix tem voz + efeitos.
- **Velocidade de render**: captura quadro a quadro na CPU (não medida para um longo completo neste ambiente; o e2e de 18 s a 1080p + curto 9:16 roda em ~90 s incluindo voz e alinhamento). Renders são cacheados por cena.
- **Agente local pareado** para interface hospedada: não implementado (opcional nesta versão; o app roda só em 127.0.0.1).
- **Publicação no YouTube**: deliberadamente ausente. O pacote (MP4, descrição, palavras-chave, capítulos, créditos) é para publicação manual.
- **FFmpeg 6.1** foi usado aqui; o Lemo-Opuscar recomenda 7+ para o pipeline dele, mas o nosso pipeline não depende dos recursos do 7.
