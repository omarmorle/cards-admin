# n8n: del deck quemado a la API de cards-admin

Hoy el workflow **"My workflow"** tiene el deck de 6 cartas de Liga MX
quemado en un nodo Code (`Roll Card`) y no guarda nada. Con cards-admin
ese deck vive en la base y el `!claim` ya asigna copias reales con
**Serie n/m**. El flujo en WhatsApp no cambia para el usuario:
`!roll` → sale una carta → `!claim` → el primero se la queda.

## Qué cambiar en el workflow

El workflow actual es:
`Webhook → If (fromMe == false) → Is Group? → Parse Command → Is Roll? / Is Help? → …`

### 1. `!roll` / `!w` — en vez del nodo `Roll Card`

Quita (o deja sin conectar) el nodo Code `Roll Card` y pon un nodo
**HTTP Request** `Roll API`:

- Método: `POST`
- URL: `http://cards-admin:3000/api/public/roll`
  (en Portainer, `cards-admin` resuelve por la red `n8n_default` que ya
  comparte el stack; si n8n no lo resuelve, usa
  `http://<IP-de-la-VM>:3000/api/public/roll`)
- Headers: `x-api-key: <API_KEY>` (la misma del stack cards-admin)
- Body JSON:
  ```json
  {
    "group_jid": "={{ $json.chatId }}",
    "rolled_by_phone": "={{ $json.senderId }}"
  }
  ```
  Opcional: `"series_id": "<id-de-la-serie>"` para sortear solo de una
  serie (por ejemplo solo Liga MX). Sin `series_id` sortea de todas las
  series activas.
- Respuesta: `{ drop_id, card, serie: "n/m", text, expires_at }`

Después, el nodo que ya manda el texto al grupo (`Send Roll Reply`)
debe mandar `{{ $json.text }}` (ya viene armado) **y guardar el
`drop_id` de ese roll**. Como n8n no tiene memoria entre mensajes,
guarda el drop pendiente en Redis con el `group_jid` como clave, por
ejemplo `drop:<group_jid>` = `drop_id`, con expiración de 5 minutos.
Ese es el paso que conecta el `!roll` con el `!claim`.

> Si prefieres no usar Redis todavía, hay un atajo temporal: en el
> mensaje del roll incluye el `drop_id` (no es bonito, pero funciona
> para probar). Lo limpio es Redis.

### 2. `!claim` — nodo nuevo

Hoy `!claim` solo aparece como "próximamente" en `!help`. Añade una
rama en el router (`Parse Command` ya separa el comando):

1. Nodo **Redis** (o Code) que lea `drop:<group_jid>` y obtenga el `drop_id` pendiente.
2. Nodo **HTTP Request** `Claim API`:
   - Método: `POST`
   - URL: `http://cards-admin:3000/api/public/claim`
   - Headers: `x-api-key: <API_KEY>`
   - Body JSON:
     ```json
     {
       "drop_id": "={{ $json.drop_id }}",
       "phone": "={{ $json.senderId }}",
       "display_name": "={{ $json.pushName || '' }}"
     }
     ```
   - Si responde 200: la copia es suya. Responde al grupo algo como
     `✅ ¡Es tuya! <nombre> — Serie n/m`.
   - Si responde **409**: alguien ya la reclamó o venció. Responde
     `Esa carta ya fue reclamada.` (el primer claim gana: en Postgres
     es una transacción con bloqueo de fila; en JSON, un solo proceso).
3. Borra la clave `drop:<group_jid>` de Redis (o déjala vencer).

### 3. `!inv` — nodo nuevo (opcional, después del claim)

- HTTP Request `GET http://cards-admin:3000/api/public/inventory?phone={{ $json.senderId }}`
- Header `x-api-key`.
- Respuesta: `{ user, copies: [{ card_name, serie, rarity, ... }] }`.
- Arma el texto con un nodo Code: una línea por carta,
  `• <nombre> — Serie n/m (Rareza)`.

### 4. Imágenes

Hoy el bot manda texto con `sendText`. Para mandar la carta con imagen,
cambia `Send Roll Reply` por el endpoint de Evolution de imagen/media
(`sendMedia` o el que tu versión de Evolution exponga) con
`image_url` de la carta (`card.image_url`, que la API de roll ya
devuelve dentro de `card`) y el texto como pie de foto. Las imágenes
las subes en el panel y viven en `/uploads/`.

## Resumen de endpoints (cards-admin)

| Acción | Método / ruta | Auth |
|---|---|---|
| Sortear | `POST /api/public/roll` | `x-api-key` |
| Reclamar | `POST /api/public/claim` | `x-api-key` |
| Inventario | `GET /api/public/inventory?phone=` | `x-api-key` |
| Series | `GET /api/public/series` | `x-api-key` |
| Cartas | `GET /api/public/cards?series_id=&rarity=` | `x-api-key` |
| Salud | `GET /api/health` | ninguna |
