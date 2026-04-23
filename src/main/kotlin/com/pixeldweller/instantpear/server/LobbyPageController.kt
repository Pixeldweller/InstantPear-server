package com.pixeldweller.instantpear.server

import org.springframework.stereotype.Controller
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable

@Controller
class LobbyPageController {

    @GetMapping("/lobby/{code}")
    fun guestPage(@PathVariable code: String): String {
        return "forward:/overlay.html"
    }

    @GetMapping("/host/{code}")
    fun hostPage(@PathVariable code: String): String {
        return "forward:/overlay.html"
    }
}
