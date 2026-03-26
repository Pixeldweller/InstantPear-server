package com.pixeldweller.instantpear.server

import org.springframework.boot.autoconfigure.SpringBootApplication
import org.springframework.boot.builder.SpringApplicationBuilder
import org.springframework.boot.runApplication
import org.springframework.boot.web.servlet.support.SpringBootServletInitializer

@SpringBootApplication
class InstantPearServerApplication : SpringBootServletInitializer() {
    override fun configure(application: SpringApplicationBuilder): SpringApplicationBuilder {
        return application.sources(InstantPearServerApplication::class.java)
    }
}

fun main(args: Array<String>) {
    runApplication<InstantPearServerApplication>(*args)
}
