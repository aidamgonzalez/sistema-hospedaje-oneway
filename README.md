# Sistema de Hospedaje · ONE WAY

Sistema web del departamento de hospedaje: reservas por año, hoteles, pagos compartidos, reportes diarios (pagos, llegadas y salidas), créditos con hoteles, tasa BCV diaria y retenciones.

- **Página:** GitHub Pages (este repositorio).
- **Datos y usuarios:** Supabase (Auth + Postgres + Realtime).

## Puesta en marcha

1. Crea un proyecto en [Supabase](https://supabase.com).
2. En **SQL Editor**, pega y ejecuta `supabase.sql`.
3. En **Authentication → Sign In / Providers → Email**, desactiva **Confirm email**.
4. En **Authentication → URL Configuration**, pon como Site URL `https://aidamgonzalez.github.io/sistema-hospedaje-oneway/`.
5. Copia la **Project URL** y la clave **anon public** (Project Settings → API) en `supabase-config.js`.
6. En **Authentication → Users → Add user**, crea el usuario del administrador con el correo de `ADMIN_EMAIL` y entra con él.
7. En **Usuarios → Importar datos**, carga el archivo de exportación `.json`.

## Roles

- **Administrador:** todo el sistema, incluidos Créditos y la gestión de usuarios.
- **Agente:** reservas, hoteles, tasas y reportes. No ve Créditos.

Los datos de reservas **no** se guardan en este repositorio; viven en Supabase, protegidos por las reglas de `supabase.sql`.
