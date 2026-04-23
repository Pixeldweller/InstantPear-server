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
        // Raw WebSocket endpoint — used by plugin PearClient (raw mode) and
        // the browser overlay page. Must not be wrapped with SockJS.
        registry.addHandler(handler, "/ws")
            .setAllowedOrigins("*")
            .addInterceptors(HttpSessionHandshakeInterceptor())

        // Optional SockJS endpoint on a separate path for clients that can't
        // hold a raw WebSocket (e.g., PearClient with useSockJS=true).
        // SockJS info/xhr endpoints carry credentials, so the wildcard origin
        // must be expressed as a pattern rather than "*".
        if (sockJsEnabled) {
            registry.addHandler(handler, "/sockjs")
                .setAllowedOriginPatterns("*")
                .addInterceptors(HttpSessionHandshakeInterceptor())
                .withSockJS()
        }
    }
}
