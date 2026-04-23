package com.pixeldweller.instantpear.server

import org.apache.catalina.connector.Connector
import org.apache.coyote.http11.AbstractHttp11Protocol
import org.apache.tomcat.util.net.SSLHostConfig
import org.apache.tomcat.util.net.SSLHostConfigCertificate
import org.slf4j.LoggerFactory
import org.springframework.beans.factory.annotation.Value
import org.springframework.boot.web.embedded.tomcat.TomcatServletWebServerFactory
import org.springframework.boot.web.server.WebServerFactoryCustomizer
import org.springframework.context.annotation.Configuration
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths
import java.util.concurrent.TimeUnit

/**
 * Adds a secondary HTTPS connector backed by an auto-generated self-signed
 * keystore when `pear.https.enabled=true`. The primary HTTP port
 * (`server.port`) is left alone so existing clients keep working.
 */
@Configuration
class HttpsConfig(
    @Value("\${pear.https.enabled:false}") private val enabled: Boolean,
    @Value("\${pear.https.port:9275}") private val httpsPort: Int,
    @Value("\${pear.https.keystore.path:data/keystore.p12}") private val keystorePath: String,
    @Value("\${pear.https.keystore.password:changeit}") private val keystorePassword: String,
) : WebServerFactoryCustomizer<TomcatServletWebServerFactory> {

    private val log = LoggerFactory.getLogger(HttpsConfig::class.java)

    override fun customize(factory: TomcatServletWebServerFactory) {
        if (!enabled) return
        val storePath = Paths.get(keystorePath).toAbsolutePath()
        ensureKeystore(storePath)

        val connector = Connector("org.apache.coyote.http11.Http11NioProtocol")
        connector.port = httpsPort
        connector.secure = true
        connector.scheme = "https"

        val proto = connector.protocolHandler as AbstractHttp11Protocol<*>
        proto.isSSLEnabled = true

        val sslHost = SSLHostConfig()
        val cert = SSLHostConfigCertificate(sslHost, SSLHostConfigCertificate.Type.RSA)
        cert.certificateKeystoreFile = storePath.toString()
        cert.certificateKeystorePassword = keystorePassword
        cert.certificateKeyAlias = "pear"
        sslHost.addCertificate(cert)
        proto.addSslHostConfig(sslHost)

        factory.addAdditionalTomcatConnectors(connector)
        log.info("HTTPS connector listening on :{} keystore={}", httpsPort, storePath)
    }

    private fun ensureKeystore(storePath: Path) {
        if (Files.exists(storePath)) return
        Files.createDirectories(storePath.parent)
        val javaHome = System.getProperty("java.home")
        val keytool = Paths.get(javaHome, "bin", if (isWindows()) "keytool.exe" else "keytool").toString()
        val cmd = listOf(
            keytool, "-genkeypair",
            "-alias", "pear",
            "-keyalg", "RSA", "-keysize", "2048",
            "-validity", "3650",
            "-storetype", "PKCS12",
            "-keystore", storePath.toString(),
            "-storepass", keystorePassword,
            "-keypass", keystorePassword,
            "-dname", "CN=InstantPear, OU=Dev, O=Pixeldweller, C=DE",
            "-ext", "SAN=dns:localhost,ip:127.0.0.1"
        )
        log.info("Generating self-signed keystore via keytool at {}", storePath)
        val p = ProcessBuilder(cmd).redirectErrorStream(true).start()
        if (!p.waitFor(30, TimeUnit.SECONDS)) {
            p.destroyForcibly()
            throw IllegalStateException("keytool timed out generating keystore")
        }
        val out = p.inputStream.bufferedReader().readText()
        if (p.exitValue() != 0) {
            throw IllegalStateException("keytool failed rc=${p.exitValue()}: $out")
        }
    }

    private fun isWindows(): Boolean =
        System.getProperty("os.name", "").lowercase().contains("win")
}
