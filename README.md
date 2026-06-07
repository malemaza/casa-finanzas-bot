# Casa Finanzas — WhatsApp Bot

## Variables de entorno necesarias en Railway:

### FIREBASE_SERVICE_ACCOUNT
El JSON de la cuenta de servicio de Firebase (ver instrucciones abajo).

### MEMBERS
JSON que mapea números de WhatsApp a miembros. Ejemplo:
```json
{"whatsapp:+5491112345678":"yo","whatsapp:+5491198765432":"marido"}
```

### TC (opcional)
Tipo de cambio USD/MXN. Default: 17.5
Ejemplo: 17.85

## Cómo obtener FIREBASE_SERVICE_ACCOUNT:
1. Firebase Console → tu proyecto → ⚙️ Configuración → Cuentas de servicio
2. Click en "Generar nueva clave privada"
3. Descargá el JSON
4. Copiá TODO el contenido del JSON y pegalo en la variable FIREBASE_SERVICE_ACCOUNT

## Comandos del bot:
- `Comida 350 tacos` → registra gasto
- `Netflix 15.99 USD streaming` → gasto en USD
- `resumen` → total del mes
- `borrar ultimo` → borra el último gasto
- `ayuda` → lista de comandos
