package com.pixeldweller.instantpear.server

import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.web.socket.server.standard.ServletServerContainerFactoryBean

@Configuration
class WebSocketTransportConfig {

    @Bean
    fun createWebSocketContainer(): ServletServerContainerFactoryBean {
        val container = ServletServerContainerFactoryBean()
        container.setMaxTextMessageBufferSize(512 * 1024)  // 512KB per message (chunks are 256KB)
        container.setMaxBinaryMessageBufferSize(512 * 1024)
        return container
    }
}
