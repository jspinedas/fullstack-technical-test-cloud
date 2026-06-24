# Fullstack Technical Test Cloud

## Descripción

Microservicio serverless event-driven que recibe solicitudes de generación de reportes mediante un endpoint HTTP, desacopla el procesamiento a través de Amazon SQS, y procesa cada solicitud de forma asíncrona para simular la generación de un reporte y enviar un correo de confirmación mediante Amazon SES.

Implementado con AWS SAM, Node.js 20.x y AWS SDK v3 exclusivamente.

---

## Arquitectura

```
Cliente
  │
  ▼
API Gateway (HTTP API)
  │  POST /reports
  ▼
Lambda Producer          ── valida payload, publica en SQS
  │
  ▼
SQS Cola Principal   ────── desacopla productor y consumidor
  │                  └── SQS Dead Letter Queue (tras 3 fallos)
  ▼
Lambda Worker            ── consume mensajes, simula procesamiento
  │
  ▼
Amazon SES               ── envía correo de confirmación

Observabilidad transversal:
  Lambda Producer ── AWS X-Ray
  Lambda Worker   ── AWS X-Ray
  SQS DLQ         ── CloudWatch Alarm ── SNS Topic ── Email
  Lambda Errors   ── CloudWatch Alarm ── SNS Topic ── Email
  SQS Backlog     ── CloudWatch Alarm ── SNS Topic ── Email
```

### Componentes

| Componente | Servicio AWS | Propósito |
|---|---|---|
| Endpoint HTTP | API Gateway HTTP API | Recibe solicitudes POST /reports |
| Publicación | Lambda Producer | Valida el payload y publica en SQS |
| Buffer | SQS Cola Principal | Desacopla productor y consumidor, absorbe picos |
| Resiliencia | SQS Dead Letter Queue | Almacena mensajes que fallaron 3 veces consecutivas |
| Procesamiento | Lambda Worker | Consume mensajes, simula generación y envía correo |
| Envío | Amazon SES | Entrega el correo de confirmación al destinatario |
| Alertas | SNS Topic | Distribuye notificaciones operativas por email |
| Monitoreo | CloudWatch Alarms (×3) | Detecta mensajes en DLQ, errores Lambda y backlog en cola |
| Trazabilidad | AWS X-Ray | Trazas distribuidas en ambas funciones Lambda |

---

## Flujo de procesamiento

### 1. Cliente envía POST /reports

```http
POST /reports
Content-Type: application/json

{
  "email": "usuario@correo.com",
  "reportType": "monthly"
}
```

### 2. Producer valida el payload

`Lambda Producer` (`src/handlers/producer.js`) parsea el body HTTP y llama a `validateReportPayload` (`src/utils/validation.js`). Si el payload es inválido, responde inmediatamente con HTTP 400 sin publicar nada en SQS.

### 3. Producer publica mensaje en SQS

Si la validación pasa, Producer publica en la cola principal un mensaje JSON que contiene `email`, `reportType` y el `requestId` generado por API Gateway. La respuesta al cliente es inmediata: HTTP 202.

### 4. Worker consume el mensaje

`Lambda Worker` (`src/handlers/worker.js`) recibe el mensaje de SQS. Puede procesar hasta 10 mensajes por invocación (`BatchSize: 10`). Cada mensaje se procesa de forma independiente gracias a `ReportBatchItemFailures`: si un mensaje falla, los demás del mismo batch no se ven afectados.

### 5. Worker simula generación del reporte

El Worker re-valida el payload de forma defensiva y ejecuta una pausa de 2 segundos (`PROCESSING_DELAY_MS = 2000`) que simula el procesamiento pesado de generación del reporte.

### 6. Worker envía correo mediante SES

Llama a `sendReportEmail` (`src/services/emailService.js`), que construye y envía el correo:

- **Remitente:** valor del parámetro `SourceEmail`
- **Destinatario:** `email` del payload original
- **Asunto:** `Your {reportType} report is ready`
- **Cuerpo:** `Your {reportType} report has been processed successfully. Request ID: {requestId}`

### 7. Manejo de errores y DLQ

Si cualquier paso del Worker falla (JSON inválido, validación, error de SES), el mensaje se agrega al array `batchItemFailures` y vuelve a SQS. Después de 3 fallos consecutivos (`maxReceiveCount: 3`), SQS mueve el mensaje a la Dead Letter Queue. El `DLQAlarm` detecta la presencia de mensajes en la DLQ y notifica al equipo vía SNS.

---

## Estructura del proyecto

```
fullstack-technical-test-cloud/
├── template.yaml               # Infraestructura AWS SAM completa
├── package.json                # Dependencias y scripts npm
├── src/
│   ├── handlers/
│   │   ├── producer.js         # Handler Lambda Producer (HTTP → SQS)
│   │   └── worker.js           # Handler Lambda Worker (SQS → SES)
│   ├── services/
│   │   └── emailService.js     # Cliente SES desacoplado de los handlers
│   └── utils/
│       ├── logger.js           # Logger estructurado JSON
│       └── validation.js       # Validación del payload de reporte
└── utils/
    └── project-context.md      # Especificación y decisiones arquitectónicas
```

---

## Endpoint disponible

### POST /reports

Solicita la generación de un reporte. El procesamiento es asíncrono: la respuesta HTTP confirma que el mensaje fue aceptado, no que el correo fue enviado.

**URL:** `https://{api-id}.execute-api.{region}.amazonaws.com/{Environment}/reports`

La URL exacta queda disponible en el Output `ApiEndpoint` tras ejecutar `sam deploy`.

#### Request

```json
{
  "email": "usuario@correo.com",
  "reportType": "monthly"
}
```

| Campo | Tipo | Requerido | Descripción |
|---|---|---|---|
| `email` | string | Sí | Dirección de correo del destinatario |
| `reportType` | string | Sí | Tipo de reporte a generar |

**Valores válidos de `reportType`:**

- `daily`
- `weekly`
- `monthly`
- `annual`

#### Respuesta exitosa — HTTP 202

```json
{
  "message": "Report request accepted",
  "requestId": "MXzPqrs-..."
}
```

#### Respuesta de validación — HTTP 400

Body o JSON inválido:

```json
{
  "message": "Request body must be valid JSON"
}
```

Campos faltantes o `reportType` no reconocido:

```json
{
  "message": "Validation failed",
  "errors": [
    "reportType must be one of: daily, weekly, monthly, annual"
  ]
}
```

#### Error de infraestructura — HTTP 500

Solo cuando SQS no puede aceptar el mensaje:

```json
{
  "message": "Internal server error"
}
```

---

## Recursos AWS desplegados

Los nombres de recursos incluyen el sufijo `{Environment}` (valor del parámetro `Environment`, por defecto `dev`).

| Recurso lógico | Nombre en AWS | Tipo | Propósito |
|---|---|---|---|
| `ReportsApi` | *(generado por SAM)* | API Gateway HTTP API | Expone POST /reports |
| `ProducerFunction` | `report-producer-{Environment}` | Lambda (256 MB / 10s) | Valida y publica en SQS |
| `WorkerFunction` | `report-worker-{Environment}` | Lambda (512 MB / 30s) | Procesa mensajes y envía correos |
| `ReportsQueue` | `reports-queue-{Environment}` | SQS Standard Queue | Cola principal (VisibilityTimeout 180s) |
| `ReportsDLQ` | `reports-dlq-{Environment}` | SQS Standard Queue | Dead Letter Queue (retención 4 días) |
| `AlertsTopic` | `reports-alerts-{Environment}` | SNS Topic | Receptor centralizado de alarmas |
| `DLQAlarm` | `reports-dlq-not-empty-{Environment}` | CloudWatch Alarm | Dispara cuando DLQ tiene mensajes |
| `WorkerErrorsAlarm` | `report-worker-errors-{Environment}` | CloudWatch Alarm | Dispara ante errores en Lambda Worker |
| `QueueBacklogAlarm` | `reports-queue-backlog-{Environment}` | CloudWatch Alarm | Dispara cuando mensajes envejecen más de 300s en cola |

### Configuración de las colas SQS

| Propiedad | Cola principal | DLQ |
|---|---|---|
| `VisibilityTimeout` | 180s (6× Lambda timeout) | — |
| `MessageRetentionPeriod` | 345600s (4 días) | 345600s (4 días) |
| `maxReceiveCount` | 3 intentos antes de pasar a DLQ | — |
| `BatchSize` (Worker) | 10 mensajes por invocación | — |
| `MaximumBatchingWindowInSeconds` | 5s | — |

---

## Variables de configuración

Todos los parámetros se proveen durante `sam deploy --guided` o en `samconfig.toml`.

| Parámetro | Tipo | Default | Requerido | Descripción |
|---|---|---|---|---|
| `Environment` | String | `dev` | No | Sufijo de todos los recursos. Valores permitidos: `dev`, `staging`, `prod` |
| `SourceEmail` | String | — | **Sí** | Correo verificado en SES desde el que se envían los reportes |
| `ConfigurationSetName` | String | — | **Sí** | Nombre del Configuration Set de SES para rastreo de entregas, rebotes y quejas |
| `AlertEmail` | String | — | **Sí** | Correo que recibirá notificaciones operativas vía SNS |
| `MaximumConcurrency` | Number | `10` | No | Límite de invocaciones simultáneas del Worker. Controla la tasa de envío hacia SES (rango: 2–1000) |

---

## Observabilidad

### CloudWatch Logs

Ambas funciones Lambda emiten logs en formato JSON estructurado hacia CloudWatch Logs. Cada entrada incluye nivel, timestamp, ambiente y los metadatos relevantes al evento:

```json
{
  "level": "info",
  "timestamp": "2024-01-15T10:30:00.000Z",
  "environment": "dev",
  "message": "Email sent",
  "to": "usuario@correo.com",
  "reportType": "monthly",
  "requestId": "MXzPqrs-...",
  "messageId": "abc123"
}
```

Los logs son consultables con CloudWatch Logs Insights. Para correlacionar Producer y Worker de una misma solicitud, filtrar por `requestId`.

### CloudWatch Alarms

Tres alarmas independientes cubren los escenarios de fallo más críticos:

| Alarma | Métrica | Condición | Comportamiento |
|---|---|---|---|
| `reports-dlq-not-empty-{Environment}` | `SQS ApproximateNumberOfMessagesVisible` | `> 0` cada 60s | Notifica al entrar en ALARM y al salir (DLQ vacía = recuperación confirmada) |
| `report-worker-errors-{Environment}` | `Lambda Errors` | `> 0` cada 60s | Notifica ante cualquier error en Lambda Worker |
| `reports-queue-backlog-{Environment}` | `SQS ApproximateAgeOfOldestMessage` | `> 300s` cada 300s | Notifica si hay acumulación de mensajes en la cola principal |

### SNS Notifications

El topic `reports-alerts-{Environment}` centraliza todas las alarmas. Tras el despliegue, AWS envía un correo de confirmación a `AlertEmail` que debe aceptarse antes de recibir notificaciones.

### AWS X-Ray

X-Ray está habilitado en ambas funciones Lambda mediante `Tracing: Active` en la sección `Globals` del template. Permite visualizar la latencia, los cuellos de botella y el rastro completo de cada invocación.

> **Nota:** `AWS::Serverless::HttpApi` (HTTP API v2) no expone la configuración de X-Ray en CloudFormation. Para activar el rastreo en API Gateway, debe habilitarse manualmente desde la consola de AWS o mediante CLI tras el despliegue.

---

## Escenarios de comportamiento

Los siguientes escenarios describen el comportamiento del sistema derivado directamente del código fuente.

### Caso exitoso

**Condición:** payload válido, email verificado en SES.

1. `POST /reports` con `{ "email": "verificado@dominio.com", "reportType": "monthly" }`
2. Producer valida — pasa. Publica en SQS
3. Producer responde HTTP 202 con `requestId`
4. Worker recibe mensaje (batching de hasta 5s)
5. Worker re-valida, simula procesamiento (~2 segundos)
6. Worker llama a `sendReportEmail` → SES acepta
7. Destinatario recibe correo con asunto: `Your monthly report is ready`
8. Worker retorna `{ batchItemFailures: [] }` → SQS elimina el mensaje

### Caso validación incorrecta

**Condición:** `reportType` fuera del catálogo.

```http
POST /reports
{ "email": "usuario@correo.com", "reportType": "quarterly" }
```

Respuesta inmediata. SQS no recibe ningún mensaje:

```http
HTTP 400
{
  "message": "Validation failed",
  "errors": ["reportType must be one of: daily, weekly, monthly, annual"]
}
```

### Caso error SES — tres fallos consecutivos

**Condición:** email no verificado en SES Sandbox, o fallo transitorio de SES.

1. `POST /reports` válido → Producer responde HTTP 202 → mensaje llega a SQS
2. **Intento 1:** Worker procesa, `sendReportEmail` lanza excepción → mensaje en `batchItemFailures` → `ReceiveCount = 1` → SQS re-encola (espera VisibilityTimeout: 180s)
3. **Intento 2:** mismo resultado → `ReceiveCount = 2` → SQS re-encola
4. **Intento 3:** mismo resultado → `ReceiveCount = 3 = maxReceiveCount`
5. SQS mueve el mensaje a `reports-dlq-{Environment}`
6. `DLQAlarm` detecta `ApproximateNumberOfMessagesVisible > 0` dentro de 60s → notifica vía SNS
7. `WorkerErrorsAlarm` también dispara por los 3 errores Lambda registrados
8. El mensaje permanece en DLQ durante 4 días para diagnóstico y redriving manual

---

## Despliegue

### Pre-requisitos

- AWS CLI configurado (`aws configure`)
- AWS SAM CLI instalado (`sam --version`)
- Node.js 20.x (`node --version`)
- Correo o dominio verificado en Amazon SES
- Configuration Set creado en SES

### Comandos

```bash
# Instalar dependencias de producción y desarrollo
npm install

# Validar el template SAM
sam validate

# Compilar los artefactos Lambda
sam build

# Desplegar interactivamente (primera vez)
sam deploy --guided
```

Durante `sam deploy --guided`, SAM solicitará los valores de los parámetros:

```
Parameter Environment [dev]:
Parameter SourceEmail: joan.emisor@test.com
Parameter ConfigurationSetName: mi-configuration-set
Parameter AlertEmail: joan.receptor@test.com
Parameter MaximumConcurrency [10]:
```

Las respuestas se guardan en `samconfig.toml` para despliegues posteriores con `sam build && sam deploy`.

### Outputs disponibles tras el despliegue

| Output | Descripción |
|---|---|
| `ApiEndpoint` | URL del endpoint POST /reports |
| `ReportsQueueUrl` | URL de la cola SQS principal |
| `ReportsQueueName` | Nombre de la cola SQS principal |
| `ReportsDLQUrl` | URL de la Dead Letter Queue |
| `ReportsDLQName` | Nombre de la Dead Letter Queue |
| `ProducerFunctionArn` | ARN de Lambda Producer |
| `WorkerFunctionArn` | ARN de Lambda Worker |
| `AlertsTopicArn` | ARN del SNS Topic de alertas |

---

## Consideraciones

### SES Sandbox

Por defecto, las cuentas AWS nuevas operan con SES en modo Sandbox:

- Solo se puede enviar **desde** direcciones o dominios verificados en SES
- Solo se puede enviar **hacia** direcciones o dominios verificados en SES
- El parámetro `SourceEmail` debe estar verificado antes del despliegue

Para enviar a cualquier destinatario, se debe solicitar acceso a producción desde la consola de SES (AWS Support → Service Limit Increase).

### Confirmación SNS

Tras el primer despliegue, AWS envía un correo de confirmación a la dirección configurada en `AlertEmail`. Las alarmas CloudWatch no enviarán notificaciones hasta que esa confirmación sea aceptada.

### Correos en Spam

Los correos enviados desde SES pueden llegar a Spam inicialmente si el dominio de `SourceEmail` no tiene configurados SPF, DKIM y DMARC. El Configuration Set permite rastrear rebotes y quejas para diagnosticar problemas de entrega.

### DLQ como red de seguridad

Los mensajes en la Dead Letter Queue tienen retención de 4 días. Una vez resuelto el problema original, pueden re-encolarse hacia la cola principal:

```bash
aws sqs start-message-move-task \
  --source-arn <DLQ_ARN> \
  --destination-arn <QUEUE_ARN>
```

Los ARNs están disponibles como Outputs `ReportsDLQUrl` y `ReportsQueueUrl` tras el despliegue.

### Procesamiento duplicado

SQS Standard Queue puede entregar un mensaje más de una vez en condiciones de alta carga. El sistema no implementa idempotencia en esta versión. Un mismo `requestId` podría generar más de un correo en escenarios extremos.

---

## Conclusión

La solución implementa un microservicio serverless event-driven sobre AWS con los siguientes atributos técnicos, verificados en el código fuente y la infraestructura:

- **Desacoplamiento real:** API Gateway y Lambda Worker no se conocen directamente; SQS actúa como buffer con VisibilityTimeout de 180s
- **Resiliencia automática:** tres reintentos por mensaje antes de DLQ, sin intervención manual
- **Aislamiento de fallos en batch:** `ReportBatchItemFailures` garantiza que un mensaje fallido no re-procesa los mensajes exitosos del mismo batch
- **Mínimo privilegio IAM:** Producer solo puede `sqs:SendMessage`; Worker solo puede leer de SQS y enviar por SES
- **Observabilidad completa:** logs JSON estructurados con correlación por `requestId`, tres alarmas CloudWatch independientes y trazas X-Ray en Lambda
- **Infraestructura como código:** un solo `sam deploy` despliega la totalidad de los recursos sin configuración manual, excepto la confirmación SNS y la activación de X-Ray en API Gateway HTTP
