# Instruções para agentes neste repositório

- Leia `README.md`, `docs/MATRIZ.md` e `docs/LIMITACOES.md` antes de mudar algo.
- Regra central: **áudio primeiro**. Nunca relaxe o bloqueio em `server/src/pipeline/audio-gate.ts` nem em `jobs.ts` (`VISUAL_JOB_TYPES`). Jobs visuais exigem master aprovado, verificado ao enfileirar, ao iniciar e ao gravar (`commitIfCurrent`).
- Nunca aprove uma narração em nome do usuário fora dos testes automatizados.
- Segredos só no backend (`server/src/secrets.ts`); nunca em logs, frontend ou arquivos versionados.
- Testes: `npm test` (unidade + e2e com motores reais locais). Fixtures de teste não comprovam integrações pagas.
- Repositórios de referência ficam em `vendor/` (fora do Git), fixados em `refs.lock.json`. Não execute código deles sem revisar.
