# Resumo Matinal Cloud

Esta versão foi preparada para correr sem depender do computador local.

## O que faz

- Recolhe manchetes recentes para:
  - mercados e macro
  - geopolítica
  - Trump / Truth Social
  - cripto / regulação
- Recolhe preços de `BTC`, `ETH`, `SOL`, `ADA` e `INJ`
- Pede à OpenAI um resumo final em português europeu
- Envia o resultado para Telegram

## Como correr em GitHub Actions

1. Criar um repositório GitHub com estes ficheiros.
2. Adicionar os seguintes `Secrets and variables > Actions > Secrets`:
   - `OPENAI_API_KEY`
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_CHAT_ID`
3. `OPENAI_API_KEY` é agora opcional.
4. Opcionalmente adicionar `OPENAI_MODEL`.
   - Se não definires, o script usa `gpt-5.4-mini`.
5. Por defeito o workflow corre com `USE_OPENAI=false`, para evitar falhas de quota.
   - Se mais tarde quiseres voltar a usar a OpenAI, muda `USE_OPENAI` para `true` no workflow e garante que a conta tem quota.
6. Ativar o workflow em `.github/workflows/daily-market-brief.yml`.

## Horário

O workflow corre todos os dias e faz validação interna do fuso `Europe/Lisbon` para só enviar às `08:00` locais, incluindo mudanças de hora.

## Teste manual

No GitHub Actions, usa `Run workflow`.

Localmente, com variáveis de ambiente configuradas:

```powershell
node .\scripts\daily-market-brief.mjs
```

## Limites conhecidos

- Esta versão não inclui agenda nem emails.
- O bloco `Truth Social` depende de cobertura pública recente; se não houver sinais fiáveis, o resumo deve assinalar essa incerteza.
