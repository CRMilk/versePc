package com.verse.explorer.web.routes

import com.verse.explorer.web.models.*
import io.ktor.server.application.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import io.ktor.server.websocket.*
import io.ktor.websocket.*
import kotlinx.coroutines.isActive

fun Routing.gameRoutes() {
    route("/game") {
        post("/launch") {
            call.respond(ApiResponse(success = true, message = "Game launching..."))
        }
        
        post("/stop") {
            call.respond(ApiResponse(success = true, message = "Game stopped"))
        }
        
        get("/status") {
            val status = GameStatus(
                isRunning = false,
                version = "1.20.4",
                fps = 0,
                memoryUsed = 0,
                memoryMax = 2048
            )
            call.respond(ApiResponse(success = true, data = status))
        }
        
        webSocket("/ws") {
            try {
                send("Connected to Verse Explorer X")
                
                var fps = 60
                var memoryUsed = 512L
                
                while (isActive) {
                    val status = GameStatus(
                        isRunning = true,
                        version = "1.20.4",
                        fps = fps + (-5..5).random(),
                        memoryUsed = memoryUsed + (-50..50).random(),
                        memoryMax = 2048
                    )
                    
                    send(gson.toJson(status))
                    
                    kotlinx.coroutines.delay(1000)
                    
                    fps = (30..120).random()
                    memoryUsed = (400..1500).random().toLong()
                }
            } catch (e: Exception) {
                println("WebSocket error: ${e.message}")
            }
        }
    }
}

private val gson = com.google.gson.Gson()
