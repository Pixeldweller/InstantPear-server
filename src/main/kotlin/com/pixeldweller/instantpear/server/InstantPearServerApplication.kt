package com.pixeldweller.instantpear.server

import org.springframework.boot.autoconfigure.SpringBootApplication
import org.springframework.boot.runApplication

@SpringBootApplication
class InstantPearServerApplication

fun main(args: Array<String>) {
    runApplication<InstantPearServerApplication>(*args)
}
