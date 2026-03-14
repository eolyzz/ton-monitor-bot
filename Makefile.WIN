CC=g++
CDEFINES=
SOURCES=Dispatcher.cpp Mode.cpp precomp.cpp profanity.cpp SpeedSample.cpp
OBJECTS=$(SOURCES:.cpp=.o)
EXECUTABLE=profanity3.exe

# windows
#LDFLAGS=-s -I"/c/Program Files/NVIDIA GPU Computing Toolkit/CUDA/v11.8/include" -L"/c/Program Files/NVIDIA GPU Computing Toolkit/CUDA/v11.8/lib/x64" -lOpenCL -lws2_32
LDFLAGS=-s -static -static-libgcc -I./OpenCLWrapper/src/OpenCL/include -L./OpenCLWrapper/src/OpenCL/lib -lOpenCL -lws2_32
CFLAGS=-c -std=c++17 -Wall -mmmx -O2

all: $(SOURCES) $(EXECUTABLE)

$(EXECUTABLE): $(OBJECTS)
	$(CC) $(OBJECTS) $(LDFLAGS) -o $@

.cpp.o:
	$(CC) $(CFLAGS) $(CDEFINES) $< -o $@

clean:
	rm -rf *.o

