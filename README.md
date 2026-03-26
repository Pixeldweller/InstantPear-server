# InstantPear Server

WebSocket server for [InstantPear](https://github.com/Pixeldweller/InstantPear-intellij-plugin), a multiplayer live coding plugin for IntelliJ.

Handles lobby management, message routing, and real-time collaboration between plugin clients.

## Tech Stack

- **Spring Boot 3.4.4** with `spring-boot-starter-websocket`
- **Kotlin 2.1.20**
- **Java 17** (minimum)
- **Jackson** for JSON serialization

## Build & Run

```bash
./gradlew bootRun
```

The server starts on port **9274** by default (configurable in `application.properties`).

WebSocket endpoint is available at `/ws` and `/`.

## Build

### Standalone JAR (embedded Tomcat)

```bash
./gradlew bootJar
java -jar build/libs/InstantPear-server-1.0-SNAPSHOT.jar
```

### WAR (for external Tomcat 10+)

```bash
./gradlew bootWar
```

Deploy `build/libs/InstantPear-server-1.0-SNAPSHOT.war` to your Tomcat `webapps/` directory.

## Deployment

Designed to run behind a reverse proxy (e.g. Nginx, Apache) that handles TLS termination. The server itself runs plain WebSocket — the proxy upgrades `wss://` to `ws://`.

## License

[MIT](LICENSE)
