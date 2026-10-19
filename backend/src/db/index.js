import mongoose from "mongoose"
import { DB_NAME } from "../constants.js"

const connectDB = async () => {
  try {
    const uri = process.env.MONGODB_URI

    if (!uri) {
      throw new Error("MONGODB_URI is not defined")
    }

    const connectionInstance = await mongoose.connect(uri, {
      dbName: DB_NAME,
    })

    console.log(
      `MongoDB connected. DB Host: ${connectionInstance.connection.host}`
    )
  } catch (error) {
    console.log("MONGODB connection error:", error.message)
    process.exit(1)
  }
}

export default connectDB