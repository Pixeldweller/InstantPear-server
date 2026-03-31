package com.pixeldweller.instantpear.server

import org.springframework.beans.factory.annotation.Value
import org.springframework.context.annotation.Configuration
import org.springframework.web.socket.config.annotation.EnableWebSocket
import org.springframework.web.socket.config.annotation.WebSocketConfigurer
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry
import org.springframework.web.socket.server.support.HttpSessionHandshakeInterceptor

@Configuration
@EnableWebSocket
class WebSocketConfig(
    private val handler: PearWebSocketHandler,
    @Value("\${websocket.sockjs.enabled:false}") private val sockJsEnabled: Boolean
) : WebSocketConfigurer {

    override fun registerWebSocketHandlers(registry: WebSocketHandlerRegistry) {
        val registration = registry.addHandler(handler, "/ws", "/")
            .setAllowedOrigins("*")
            .addInterceptors(HttpSessionHandshakeInterceptor())
        if (sockJsEnabled) {
            registration.withSockJS()
        }
    }
}
