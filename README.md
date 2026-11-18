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
(un común puede ser 500, un épico 25). Al sortear se reserva el siguiente
número `n`: copias ya emitidas + 1. Si `n > m`, esa carta ya no sale.

Ejemplo: Henry Martín, Épico, `m = 25`. La primera persona que lo reclama
tiene **Serie 1/25**, la siguiente **Serie 2/25**, y así. El `1/25` es el
más cotizado. El número se reserva en el `!roll`, no en el `!claim`, para
que dos rolls seguidos no repitan el mismo número.

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

## Cómo conectar Postgres (después, cuando quieras)

1. En Portainer abre el stack **whatsapp-bot** y copia la configuración
   de `postgres_evo`: usuario, contraseña y nombre de la base de datos.
   Esos datos **no** están en este repo, no los inventé.
2. En el stack `cards-admin` añade la variable:
   `DATABASE_URL=postgres://USUARIO:CONTRASENA@postgres_evo:5432/NOMBRE_DB`
   (con tus datos reales) y reinicia el stack.
3. Al arrancar, la app crea las tablas sola con `schema.sql`. Si prefieres
   crearlas a mano, el archivo está en la raíz del proyecto.
4. Ojo: el panel en modo JSON y en modo Postgres **no comparten datos**.
   Si ya sembraste cartas en JSON y luego cambias a Postgres, tendrás
   que sembrar de nuevo (botón *Cargar datos de ejemplo*) o exportar el
   catálogo desde el panel y volver a cargarlo.

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
- `GET /api/public/inventory?phone=...` → copias de ese usuario con su Serie n/m.
- `GET /api/public/series` y `GET /api/public/cards?series_id=&rarity=` → catálogo.

## Lo que todavía tienes que hacer tú

- [ ] Desplegar el stack en Portainer y poner tu `ADMIN_PASSWORD` y `API_KEY`.
- [ ] Añadir el hostname en Cloudflare Tunnel (ej. `admin.omarmoreno.dev`).
- [ ] Poner las credenciales reales de `postgres_evo` en `DATABASE_URL` cuando quieras pasar de JSON a Postgres.
- [ ] Subir las imágenes anime de las cartas (sin escudos ni logos).
- [ ] Cambiar en n8n el `!roll` quemado por la llamada a `/api/public/roll` y el `!claim` por `/api/public/claim` (ver `n8n/roll-claim-notes.md`).
- [ ] Probar `!roll` y `!claim` en un grupo de prueba antes de usarlo en serio.

## Probarlo en local (sin Docker)

```bash
npm install
PORT=3100 DATA_DIR=/tmp/cards-admin-test ADMIN_PASSWORD=admin123 API_KEY=test-key node server.js
# Panel: http://localhost:3100  (admin / admin123)
# Salud: curl http://localhost:3100/api/health
```
