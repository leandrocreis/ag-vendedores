# Worker RunPod Serverless (cenas por IA)

A chave RunPod sozinha não cria um serviço de geração. Este worker é o serviço; o E Se? Studio só envia jobs para o endpoint que **você** cria.

1. Construa a imagem a partir da raiz do repositório e publique num registro seu:
   `docker build -t <registro>/ese-wan-worker:0.1.0 -f runpod-worker/Dockerfile . && docker push <registro>/ese-wan-worker:0.1.0`
2. No console RunPod, crie um **Serverless Endpoint** com essa imagem (GPU ≥ 16 GB recomendada; Wan2.1 T2V 1.3B usa ~8 GB a 480p). Defina workers mínimos = 0 para não pagar ociosidade e um timeout de execução.
3. Opcional: anexe um Network Volume em `/runpod-volume` para cachear os pesos (`HF_HOME`).
4. No app: Configurações → RunPod → chave, ID do endpoint, imagem/versão, GPU, concorrência, timeout, preço por segundo (para estimativas) → **Testar runpod** (`/health`).

Contrato: veja o cabeçalho de `handler.py`. O app grava o ID remoto antes de esperar, consulta `/status/{id}` para retomar sem reenviar, chama `/cancel/{id}` ao cancelar, baixa o MP4 (base64), valida com ffprobe, descarta qualquer áudio embutido e só então marca como pronto. O app nunca liga, desliga ou apaga Pods/volumes.

**Verificação real pendente:** não houve chave nem endpoint neste ambiente; confira a documentação vigente da RunPod antes do primeiro uso pago.
