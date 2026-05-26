package com.verse.explorer.web

import com.verse.explorer.web.plugins.configureCORS
import com.verse.explorer.web.plugins.configureRouting
import com.verse.explorer.web.plugins.configureSerialization
import com.verse.explorer.web.plugins.configureWebSockets
import io.ktor.server.application.*
import io.ktor.server.engine.*
import io.ktor.server.netty.*

fun main() {
    embeddedServer(Netty, port = 8080, host = "0.0.0.0", module = Application::module)
        .start(wait = true)
}

fun Application.module() {
    configureCORS()
    configureSerialization()
    configureWebSockets()
    configureRouting()
    
    println("=" * 50)
    println("Verse Explorer X Web Server")
    println("Server started at http://localhost:8080")
    println("=" * 50)
}

operator fun String.times(n: Int): String = this.repeat(n)
