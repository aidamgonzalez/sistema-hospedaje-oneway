# Sistema de Hospedaje · ONE WAY

Sistema web del departamento de hospedaje: reservas por año, hoteles, pagos compartidos, reportes diarios (pagos, llegadas y salidas), créditos con hoteles, tasa BCV diaria y retenciones.

- **Página:** GitHub Pages (este repositorio).
- **Datos y usuarios:** Firebase (Authentication + Firestore).

## Puesta en marcha

1. Crea un proyecto en [Firebase](https://console.firebase.google.com), activa **Authentication → Correo/contraseña** y crea la base **Firestore**.
2. Copia la configuración web del proyecto en `firebase-config.js`.
3. En Firestore → **Reglas**, pega el contenido de `firestore.rules` y publica.
4. En Authentication → **Configuración → Dominios autorizados**, agrega `aidamgonzalez.github.io`.
5. Entra a la página. En Firebase → Authentication → **Usuarios**, crea el usuario del administrador con el correo de `ADMIN_EMAIL` y entra con él: el sistema lo registra como administrador.
6. En **Usuarios → Importar datos**, carga el archivo de exportación `.json`.

## Roles

- **Administrador:** todo el sistema, incluidos Créditos y la gestión de usuarios.
- **Agente:** reservas, hoteles, tasas y reportes. No ve Créditos.

Los datos de reservas **no** se guardan en este repositorio; solo viven en Firebase, protegidos por las reglas de `firestore.rules`.
