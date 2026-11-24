# cards-admin — panel y API para EDOMEXBOT

Panel web + API para gestionar las cartas del bot de WhatsApp. **No está
desplegado en tu VM**: esto es el código listo para que tú lo despliegues
en Portainer cuando quieras.

## ¿Qué es?

El bot ya no sortea cartas quemadas en el código de n8n. Ahora las cartas
viven en una base (Postgres o un archivo JSON) y tú las gestionas desde
una web. El sistema es **abstracto**: no está atado a la Liga MX.

- **Serie** = una colección. Ej.: *Liga MX - Apertura 2026*, *Luchadores de México*.
- **Carta** = la plantilla. Nombre, equipo/grupo, posición/rol, rareza, imagen y su máximo de copias.
- **Copia** = el ejemplar que le toca a alguien. Tiene su **Serie n/m**.
- **Drop** = la carta que salió en un `!roll` y está esperando `!claim`.
- **Usuario / Transacción** = quién tiene qué, y el historial de claims.

## ¿Cómo funciona Serie n/m?

Cada carta tiene un máximo de copias `m` que tú defines al crearla
(un común puede ser 500, un épico 25). Al sortear se reserva un número
`n` **al azar** entre los libres de esa carta (de 1 a `m`, sin repetir
los que ya tienen copia o están en un drop pendiente). El número bajo
sigue siendo más cotizado, pero ya no sale en orden: la primera copia
puede ser 7/25 y la segunda 2/25.

El número se reserva en el `!roll`, no en el `!claim`, para que dos
rolls seguidos no repitan el mismo número. Si ya no quedan números
libres, esa carta está agotada y no sale.

## Rareza y sorteo

Pesos base del sorteo (se renormalizan entre las rarezas que sí tengan
cartas disponibles y sin agotar):

| Rareza | Peso |
|---|---|
| Común | 50 |
| Raro | 33 |
| Épico | 15 |
| Legendario | 2 |

Con solo Común/Raro/Épico queda 50 / 33 / 17, como el deck actual de n8n.
Primero se sortea la rareza con esos pesos y luego una carta al azar de
esa rareza. Un drop vive **5 minutos**: si nadie escribe `!claim` en ese
tiempo, vence y su número vuelve a estar disponible.

## Datos de ejemplo

Al arrancar con la base vacía se siembran solos:

- **Liga MX - Apertura 2026**: Henry Martín (Épico, 25), Sergio Canales
  (Épico, 25), Gignac (Raro, 100), Alexis Vega (Raro, 100), Malagón
  (Común, 500), Chiquete (Común, 500). Sin imagen todavía: tú subes las
  imágenes anime después.
- **Luchadores de México** (ejemplo): El Santo (Épico, 25), Blue Demon
  (Raro, 100), Mil Máscaras (Común, 500).

## Cómo desplegarlo en Portainer

1. Sube esta carpeta a un repo de GitHub (o copia los archivos en el
   stack). En Portainer: **Stacks → Add stack → nombre `cards-admin`**,
   pega el `docker-compose.yml` o elige el repo.
2. Antes de desplegar, cambia en el compose: `ADMIN_PASSWORD` y `API_KEY`.
   Deja `DATABASE_URL` comentado al inicio: así arranca en modo JSON y
   puedes probar el panel sin tocar Postgres.
3. Deploy. Entra al panel por `http://<tu-VM>:3000` o por el hostname
   que le pongas en Cloudflare (paso 4).
4. **Cloudflare Tunnel** (el mismo que ya usas): en el panel de
   Cloudflare añade un hostname, por ejemplo `admin.omarmoreno.dev`,
   apuntando a `http://cards-admin:3000` (o a `http://<IP-de-la-VM>:3000`).
   Con eso el panel queda con HTTPS y sin exponer puertos extra.

## Cómo conectar Postgres (base de datos real)

Hasta ahora el panel corría en **modo JSON** (un archivo
`cards-data.json`). Para pasarlo a **Postgres real** hay que migrar los
datos que ya existen, porque JSON y Postgres no comparten nada.

### Migrar de JSON a Postgres

El script `scripts/migrate.js` copia el JSON completo a Postgres con el
estado exacto (mismos ids, fechas, series, cartas, copias, usuarios,
drops y transacciones). También **crea la base de datos `cards_admin`**
si no existe, separada de la de Evolution API.

**Orden recomendado** (en producción, en Portainer):

1. En el stack `cards-admin` define la variable:
   `DATABASE_URL=postgres://USUARIO:CONTRASENA@postgres_evo:5432/cards_admin`
   con el usuario y la contraseña de `postgres_evo` (del stack
   whatsapp-bot). La BD `cards_admin` no tiene que existir: la crea el
   script. **No** pongas la contraseña en el `docker-compose.yml`.
2. Despliega el stack con el código nuevo (que ya incluye
   `scripts/migrate.js`).
3. Antes de arrancar con `DATABASE_URL`, abre la consola del contenedor
   en Portainer (**Containers → cards-admin → Exec**) y corre:
   ```bash
   DATABASE_URL=postgres://USUARIO:CONTRASENA@postgres_evo:5432/cards_admin DATA_DIR=/data npm run migrate
   ```
   El script crea la BD, aplica `schema.sql` y copia el JSON. Al final
   verifica que los conteos coincidan y te lo muestra.
4. Reinicia el contenedor. Al arrancar con `DATABASE_URL`, la app usa
   Postgres. El archivo JSON queda intacto como respaldo.

**Si el servidor ya arrancó antes con `DATABASE_URL` y se sembró solo:**
al arrancar en modo Postgres con la BD vacía, la app siembra las 2
series y 9 cartas de ejemplo. En ese caso la migración se negaría para
no duplicar. Corre entonces con el flag `--reset-catalog`, que vacía
las 6 tablas antes de insertar el JSON:
```bash
DATABASE_URL=... DATA_DIR=/data node scripts/migrate.js --reset-catalog
```

**Si no hay JSON que migrar** (instalación nueva): la app crea las
tablas sola, pero **no crea la base de datos**. Primero crea la BD y el
esquema con el script en modo vacío y luego arranca (ahí sí siembra
solos los datos de ejemplo):
```bash
DATABASE_URL=postgres://USUARIO:CONTRASENA@postgres_evo:5432/cards_admin npm run migrate --init-empty
```

**Volver a JSON:** quita `DATABASE_URL` y reinicia. El modo JSON sigue
funcionando como antes (fallback). Ojo: los datos de Postgres no vuelven
solos al JSON; habría que exportar el catálogo desde el panel.

## Paginación

Las listas del panel (cartas, copias y usuarios) paginan de **20 en 20**.
La API acepta `?page=N&limit=M` (límite máximo 100 por página):

```bash
GET /api/admin/cards?page=2&limit=20
GET /api/admin/copies?page=1&limit=20&search=canales
GET /api/admin/users?page=1&limit=20
```

Respuesta:
```json
{ "items": [ ... ], "page": 2, "limit": 20, "total": 35, "pages": 2 }
```

Sin `page` ni `limit` la API devuelve el arreglo completo como antes
(compatibilidad: así la siguen usando el sorteo y la API pública).

## Importar cartas desde CSV

En el panel, sección **Importar cartas desde CSV**: elige la serie
destino, sube el `.csv`, revisa la **vista previa** y confirma.

Formato (primera fila = encabezados):

```csv
name,team_or_group,position_or_role,rarity,max_copies,image_url,value
Henry Martín,América,Delantero,Épico,25,,100
Luis Malagón,América,Portero,Común,500,,10
```

- Columnas: `name` (obligatoria), `team_or_group`,
  `position_or_role`, `rarity`, `max_copies`, `image_url`, `value`.
- `rarity` debe ser `Común`, `Raro`, `Épico` o `Legendario`
  (si se deja vacía, queda `Común`). `max_copies` debe ser mayor que 0.
- Los valores con comas van entre comillas: `"Pérez, Juan"`.
- El panel tiene un botón **Descargar plantilla CSV** con el formato.
- Al importar, el servidor valida cada fila con las mismas reglas que
  al crear una carta a mano y te reporta cuántas se importaron y cuáles
  fallaron, con el número de fila y el motivo
  (ej. `Fila 26 (Carta Mala): Rareza inválida…`). Máximo 500 por vez.
- Endpoint (por si lo quieres usar directo):
  `POST /api/admin/import-cards` con `{ series_id, cards: [...] }` y
  sesión de admin.

## Lo que todavía tienes que hacer tú

- [ ] Desplegar el stack en Portainer y poner tu `ADMIN_PASSWORD` y `API_KEY`.
- [ ] Añadir el hostname en Cloudflare Tunnel (ej. `admin.omarmoreno.dev`).
- [ ] Migrar a Postgres con `scripts/migrate.js` (ver arriba) cuando
      quieras dejar el JSON.
- [ ] Subir las imágenes anime de las cartas (sin escudos ni logos).
- [ ] Cambiar en n8n el `!roll` quemado por la llamada a `/api/public/roll` y el `!claim` por `/api/public/claim` (ver `n8n/roll-claim-notes.md`).
- [ ] Probar `!roll` y `!claim` en un grupo de prueba antes de usarlo en serio.

## Imágenes

- En la ficha de cada carta puedes pegar una URL de imagen o **subir**
  un archivo (jpg/png/webp, máx. 5 MB). Se guarda en `/data/uploads` y
  se sirve en `/uploads/<archivo>`.
- Las imágenes **no** van dentro de la base: solo se guarda su URL.
- En el despliegue real las imágenes viven en el volumen
  `cards-admin-data`, así que sobreviven a reinicios. Para mandar la
  carta por WhatsApp, n8n usa esa URL con el endpoint de imagen de
  Evolution (ver `n8n/roll-claim-notes.md`).

## Cómo n8n usa la API pública

Todas las rutas `/api/public/*` llevan la cabecera `x-api-key: <API_KEY>`.
Ver el detalle y los nodos en `n8n/roll-claim-notes.md`. Resumen:

- `POST /api/public/roll` `{series_id?, group_jid, rolled_by_phone}` →
  devuelve `drop_id`, la carta, `serie: "n/m"` y el texto listo para
  mandar al grupo.
- `POST /api/public/claim` `{drop_id, phone, display_name}` → el primer
  claim gana; el segundo recibe error 409.
- `POST /api/public/gift` `{copy_id, from_phone, to_phone, to_display_name?}` →
  regala una copia a otro usuario. Valida: campos faltantes → 400, regalo
  a uno mismo → 400, copia inexistente → 404, la copia no es de
  `from_phone` → 409, copia desechada (`scrapped`) → 409. Crea el usuario
  receptor si no existe, cambia el dueño, pone `status: 'gifted'` y registra
  una transacción `gift`. Devuelve `{ copy, card, serie: "n/m" }` con la
  copia enriquecida igual que el claim.
- `POST /api/public/scrap` `{copy_id, phone}` → desecha una copia tuya.
  Valida: campos faltantes → 400, copia inexistente → 404, la copia no es
  de `phone` → 409, ya desechada → 409. Pone `status: 'scrapped'` (la copia
  queda en la base como historial, ya no sale en el inventario) y registra
  una transacción `scrap`. Devuelve `{ copy, card, serie: "n/m" }`.
- `POST /api/public/trade` `{copy_id_a, phone_a, copy_id_b, phone_b, to_display_name_a?, to_display_name_b?}` →
  intercambio directo 1x1: A le da su copia a B y B le da la suya a A.
  Valida: campos faltantes → 400, intercambio contigo mismo → 400, copia
  inexistente → 404, dueño equivocado → 409, copia desechada → 409. Ambas
  copias quedan con `status: 'traded'` y se registran dos transacciones
  `trade` (una por copia). Devuelve `{ copy_a, copy_b, card_a, card_b }`.
- `GET /api/public/inventory?phone=...` → copias de ese usuario con su Serie n/m.
- `GET /api/public/series` y `GET /api/public/cards?series_id=&rarity=` → catálogo.

### Qué significa `copies.status`

El `status` de una copia dice **cómo llegó a su dueño actual**:

- `owned` — reclamada directo con `!claim`.
- `gifted` — llegó por regalo (`!gift`).
- `traded` — llegó por intercambio (`!trade`).
- `scrapped` — desechada (`!scrap`); no se puede regalar ni intercambiar.

El inventario (`/api/public/inventory`) muestra las copias del teléfono
**excepto las desechadas**: una carta con `status: 'scrapped'` ya no es
parte del inventario (sigue en la base como historial). El panel admin
sí las sigue viendo en la lista de Copias.

## Probarlo en local (sin Docker)

```bash
npm install
PORT=3100 DATA_DIR=/tmp/cards-admin-test ADMIN_PASSWORD=admin123 API_KEY=test-key node server.js
# Panel: http://localhost:3100  (admin / admin123)
# Salud: curl http://localhost:3100/api/health
```

Probar la migración a Postgres en local (con un Postgres corriendo en
tu máquina):

```bash
DATABASE_URL=postgres://usuario:contrasena@localhost:5432/cards_admin DATA_DIR=/tmp/cards-admin-test npm run migrate
# Arrancar en modo Postgres:
DATABASE_URL=postgres://usuario:contrasena@localhost:5432/cards_admin PORT=3100 DATA_DIR=/tmp/cards-admin-test ADMIN_PASSWORD=admin123 API_KEY=test-key node server.js
```
