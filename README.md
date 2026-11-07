# E Se? Studio

Estúdio local para criar vídeos animados de histórias hipotéticas (“E se…?”): episódios de 5–10 minutos para YouTube (16:9) e curtos verticais (9:16) para Shorts, Reels e TikTok. Interface em português do Brasil, feita para quem não programa.

**Regra central — áudio primeiro.** Ideia → roteiro → direção de voz → narração completa → **você ouve e aprova** → transcrição/alinhamento → storyboard com os tempos reais → cenas → som → revisão → exportação. Sem narração aprovada, o **backend** recusa qualquer job visual (storyboard, imagens, cenas, IA, montagem) e indica a próxima ação: *Gerar e aprovar narração*. O master aprovado (hash, versão, duração, locutores, intervalos) é o relógio de cortes, planos, legendas e cues.

## Começar

Requisitos: Node 20.11+, Python 3.10+ (recomendado 3.12, ou `uv`), FFmpeg/FFprobe com libx264, Chromium do Playwright. GPU só é necessária para cenas por IA locais.

```bash
npm run setup      # dependências, repositórios fixados, .venv, modelo de voz Kokoro (~354 MB) e diagnóstico
npm start          # abre em http://127.0.0.1:4870  (servidor + worker de produção)
npm run doctor     # diagnóstico: SO, Node, Python, FFmpeg, navegador, disco, memória, GPU, chaves, motores
```

Se o Chromium não estiver instalado: `npx playwright install chromium`. Para desenvolvimento da interface: `npm run dev` (Vite em `:5173`).

Chaves (todas opcionais; o que depende delas fica **pendente**, nunca simulado): **Configurações → Integrações**. Ficam no cofre do sistema operacional; sem cofre, em `data/segredos.json` (permissão 0600) ou em variáveis de ambiente (veja `.env.example`). O frontend só vê a versão mascarada.

## O que existe

| Área | O que faz |
|---|---|
| **Estilos** | 173 estilos descobertos nos arquivos reais: 66 Lemo-Opuscar, 98 da coleção OPUSCAR 98, 8 direções de movimento do Bang Motion e o preset autoral “Cartoon narrativo cinematográfico”. Miniatura real, nome original + português, demo oficial sob demanda (sem som automático) ou demo local gerada e rotulada, busca, filtros, favoritos, comparar dois, variações pessoais, “Atualizar catálogo” com relatório. O projeto fixa estilo **e versão**. |
| **Roteiro** | Caminho A: API Anthropic (`claude-opus-5-5`, configurável, validado em “Testar”, nunca trocado em silêncio), saída estruturada validada por schema com uma rodada de correção. Caminho B: **Preparar projeto para Claude Code** → Abrir pasta → Copiar instrução → **Importar resultados** (validação de schema). Cinco ganchos com a nota do `yt-script` (heurística, não prevê visualizações), revisão, versões, “Direção do canal” versionada. |
| **Estúdio de voz** | Catálogo por motor, “Ouvir com meu texto” (amostra gerada agora com a configuração exata), A/B com volume equalizado pelo nível medido, matriz de controles por motor (nativo / instrução textual / pós-processamento / indisponível), receitas de combinação (no Kokoro: mistura real de embeddings; descritores viram instrução só onde o motor aceita), clonagem com registro de autorização e análise de ruído/clipping/silêncio, voz por descrição (VoiceStudio), dicionário de pronúncia. |
| **Narração** | Trechos por locutor e intenção, emoção por trecho, pausas, refazer trecho, comparar takes, upload de narração própria. Master WAV 48 kHz/24 bit, nivelado por loudness entre trechos, micro-fades. Duração medida × meta com tolerância; ajuste **pelo roteiro**. Mudar texto/voz/velocidade/pausa cria nova versão, remove a aprovação e marca cenas/legendas dependentes (arquivos antigos preservados). Cache por conteúdo regenera só trechos alterados. |
| **Alinhamento** | faster-whisper local: tempos por frase (exatos, da montagem) e por palavra (ASR, com confiança); SRT. |
| **Storyboard e cenas** | Cenas e planos derivados dos tempos reais do master, cortes em fronteiras de frase. Motor próprio Canvas 2D determinístico (tempo = quadro·den/num): cenários em parallax, personagens com rig articulado, câmera motivada, luz, efeitos, transições, legenda como camada. 16 famílias de render guiadas pela paleta extraída do estilo. Modos: código, camadas (imagens OpenAI ou suas, com parallax — sem articulação) e híbrido. Cena piloto, editar movimento/luz/imagem por cena sem tocar no áudio. |
| **Cenas por IA (opcional)** | “Não” mantém tudo por código/camadas. “Sim”: seleção por cena, **Minha máquina** (Wan2.1 1.3B, Apache-2.0, GPU ≥ 8 GB detectada) ou **RunPod** (endpoint Serverless seu com o worker em `runpod-worker/`). Plano antes de executar, ID remoto salvo antes do polling, retomada sem reenviar, cancelamento, áudio embutido descartado. |
| **Som** | Kit Openverse (3 whooshes CC0/CC BY com `sons/CREDITOS.txt` e `openverse_manifest.json`), mapa de cues da timeline (ponto de sincronismo medido no arquivo; `início = alvo − offset`), mixagem por amostra, −16 LUFS / TP < −4 dBTP, verificação estéreo e mono **no MP4 exportado**, desvio de cada cue medido (A−B), 5 trechos para fone com A/B, `CUES.json`, `CUES.csv`, `RELATORIO_SOM.html` com aprovar/ajustar/deslocar por quadro. |
| **Exportação** | MP4 H.264/AAC 1920×1080 ou 1080×1920, faststart, validação de codecs, resolução, FPS, duração por quadro, loudness, quadros pretos (proposital × falha) e sincronismo da fala. |
| **Curtos** | Sugestões a partir do master aprovado; cada curto é um projeto 9:16 próprio, com master e aprovação próprios; gancho novo exige fala nova aprovada; classificação história completa / teaser (com destino) / trecho com gancho; recomposição vertical. |
| **Canal YouTube** | As 11 skills mapeadas (Ideias, Calendário, Embalagem, Metadados, Comentários, Retenção, Diagnóstico + perfil editorial). Descrição ≤ 5.000 caracteres sem cortar créditos, palavras-chave separadas por vírgula, capítulos dos tempos reais. Nada é publicado. |
| **Fila** | Jobs persistentes em SQLite, worker separado, batimento, retomada após reinício, cancelamento real, idempotência, jobs pagos interrompidos ficam pausados para não duplicar cobrança. Orçamento por projeto pausa antes da próxima geração paga. |

## Onde ficam os arquivos

```
data/estudio.sqlite                          banco (projetos, versões, aprovações, fila, custos)
data/projetos/<id>/voz/masters/              masters de narração (WAV) — o “relógio”
data/projetos/<id>/legendas/                 SRT da narração aprovada
data/projetos/<id>/cenas/                    renders por cena (cache por conteúdo)
data/projetos/<id>/exportacao/               MP4 final, versão A/B sem efeitos, mixes
data/projetos/<id>/revisao_fone/             01_abertura.mp4 … 05_encerramento.mp4 + RELATORIO_TRECHOS.json
data/projetos/<id>/sons/                     CUES.json, CUES.csv, RELATORIO_SOM.html
data/projetos/<id>/claude-code/              pasta do caminho Claude Code (CLAUDE.md, BRIEF, schema, resultados/)
sons/                                        kit Openverse + CREDITOS.txt + openverse_manifest.json
```

## Claude: dois caminhos, sem atalhos

- **A. API:** chave Anthropic própria, cobrança por uso, backend faz as chamadas.
- **B. Claude Code local:** o app prepara a pasta; você abre com a **sua** instalação oficial e a **sua** conta; o app importa e valida. O app não faz login, não pede senha nem cookies, não lê tokens, não faz proxy da assinatura. A renderização roda no seu computador, mas a inferência do Claude usa o serviço da Anthropic, e os limites da assinatura continuam valendo.

## Testes

```bash
npm test
```
- `server/test/unit.test.ts` (15): contratos, bloqueio visual no backend, transição atômica, fila/idempotência/recuperação, segredos fora da API e dos logs, CSRF/origem/host, caminhos, hookscore PT, título, descrição ≤ 5.000 com créditos, capítulos, retenção, pausas dramáticas preservadas, planos nas fronteiras de frase, receitas vocais.
- `server/test/e2e.test.ts`: **motores reais** (Kokoro, faster-whisper, Chromium, FFmpeg) com roteiro **fixture** (não vem da API): narração → aprovação (o teste simula o clique) → alinhamento → storyboard → cena piloto pela fila → montagem → MP4 validado → 5 trechos → curto 9:16 com aprovação própria → mudança de texto gera nova versão, remove aprovação, marca dependentes e preserva a exportação anterior.

Fixtures não comprovam integração com Anthropic, OpenAI, RunPod nem VoiceStudio.

## Projeto demonstrativo

“E se um apocalipse zumbi começasse enquanto você estivesse acampando?” — pacote (longo de 7 min + 3 curtos de 45–60 s), estilo autoral, sem cenas por IA. Veja [`docs/DEMO.md`](docs/DEMO.md) para o estado atual e o próximo passo (ouvir e aprovar a narração).

## Documentação

- [`docs/MATRIZ.md`](docs/MATRIZ.md) — matriz de integrações e capacidades (origem, versão, licenças, execução, hardware, credenciais, teste real).
- [`docs/LICENCAS.md`](docs/LICENCAS.md) — licenças, atribuições e obrigações (incluindo AGPL do VoiceStudio).
- [`docs/LIMITACOES.md`](docs/LIMITACOES.md) — limitações reais e verificações pendentes.
- [`runpod-worker/README.md`](runpod-worker/README.md) — implantação do worker Serverless.
